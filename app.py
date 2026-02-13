from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room
import random

app = Flask(__name__)
app.config['SECRET_KEY'] = 'werewolf_secret_key'
# [修改] 加入 ping_timeout 和 ping_interval
# ping_timeout=60: 允許客戶端 60 秒不說話 (切窗緩衝時間)
# ping_interval=25: 每 25 秒檢查一次心跳
socketio = SocketIO(app, cors_allowed_origins="*", ping_timeout=60, ping_interval=25)

games = {}

class Game:
    def __init__(self, room_id):
        self.room_id = room_id
        self.players = {} 
        self.host_sid = None
        self.phase = 'setup' 
        self.ready_players = set()
        # [修改] 新增這兩個變數來處理 PK
        self.is_pk_round = False 
        self.pk_targets = []  # 紀錄誰在 PK 台上
        # [新增] 槍手列隊：存放等待開槍的 sid
        self.shoot_queue = [] 
        
        # [新增] 紀錄下一個階段要去哪 (回到白天還是入夜)
        self.next_phase_after_shoot = None
        
        self.night_actions = {
            'wolf_votes': {}, 'seer_has_checked': False, 
            'witch_action': {'save': False, 'poison': None}, 
            'guard_protect': None, 'witch_notified': False
        }
        self.witch_potions = {'heal': True, 'poison': True}
        self.day_votes = {}
        self.pending_phase = None 
        self.shooter_sid = None   


    def get_player_list(self):
        plist = []
        for sid, p in self.players.items():
            plist.append({
                'name': p['name'], 
                'alive': p['alive'], 
                'number': p.get('number', 0),
                'is_host': (sid == self.host_sid)
            })
        plist.sort(key=lambda x: x['number'])
        return plist

    def assign_roles(self, settings):
        self.witch_potions = {'heal': True, 'poison': True}
        roles = []
        for role_name, count in settings.items():
            try:
                c = int(count)
                if c > 0: roles.extend([role_name] * c)
            except: pass
        
        sids = list(self.players.keys())
        random.shuffle(sids) 
        
        if len(roles) < len(sids):
            roles.extend(['平民'] * (len(sids) - len(roles)))
        elif len(roles) > len(sids):
            roles = roles[:len(sids)]
            
        random.shuffle(roles) 
        
        # [步驟 1] 先把所有人的身分都寫入資料庫
        for i, sid in enumerate(sids):
            self.players[sid]['role'] = roles[i]
            self.players[sid]['number'] = i + 1
            self.players[sid]['alive'] = True

        # [步驟 2] 確認所有人都 update 完畢後，再發送通知
        for sid in sids:
            role = self.players[sid]['role']
            number = self.players[sid]['number']
            
            # 告訴玩家自己的身分
            emit('game_info', {'role': role, 'number': number}, room=sid)
            
            # 如果是狼人，發送隊友名單
            if role in ['狼人', '狼王']:
                teammates = []
                for s, p in self.players.items():
                    # 只要是狼隊 (狼人/狼王) 且 不是自己，就加入名單
                    if p['role'] in ['狼人', '狼王'] and s != sid:
                        teammates.append({'name': p['name'], 'role': p['role']})
                
                # 發送名單
                emit('wolf_teammates', {'teammates': teammates}, room=sid)

    def calculate_night_result(self):
        dead = []
        wolf_kill = None
        
        # 1. 結算狼人投票
        vote_map = self.night_actions['wolf_votes']
        if vote_map:
            counts = {}
            for target in vote_map.values(): counts[target] = counts.get(target, 0) + 1
            if counts:
                wolf_kill = max(counts, key=counts.get)

        # 2. 取得神職行動
        guard_target = self.night_actions['guard_protect']
        witch_save = self.night_actions['witch_action']['save']
        witch_poison = self.night_actions['witch_action']['poison']

        # 3. 判定狼刀結果
        final_wolf_death = wolf_kill # 預設：狼人殺誰，誰就死

        if wolf_kill:
            is_guarded = (guard_target == wolf_kill)
            is_saved = witch_save # 女巫的 save 邏輯是針對狼刀位，所以 True 就是救 wolf_kill

            if is_guarded and is_saved:
                # [新增規則] 同守同救 (奶穿) -> 死亡！
                final_wolf_death = wolf_kill
            elif is_guarded:
                # 只有守衛 -> 平安
                final_wolf_death = None
            elif is_saved:
                # 只有女巫 -> 平安
                final_wolf_death = None
            else:
                # 沒人救 -> 死亡
                final_wolf_death = wolf_kill

        # 4. 寫入死亡名單
        if final_wolf_death: dead.append(final_wolf_death)
        if witch_poison: dead.append(witch_poison) # 毒藥一定死

        # 5. 更新玩家存活狀態
        for sid, p in self.players.items():
            if p['name'] in dead:
                p['alive'] = False
        
        # 6. 重置夜晚行動
        self.night_actions = {
            'wolf_votes': {}, 'seer_has_checked': False, 
            'witch_action': {'save': False, 'poison': None}, 
            'guard_protect': None, 'witch_notified': False
        }
        self.ready_players.clear()
        
        return list(set(dead))

def process_shoot_queue(room):
    game = games[room]
    
    # 1. 如果隊列裡還有人
    if game.shoot_queue:
        # 取出第一個人 (不移除，等他開完槍再移除)
        shooter_sid = game.shoot_queue[0]
        shooter_name = game.players[shooter_sid]['name']
        
        game.phase = 'shoot'
        game.shooter_sid = shooter_sid # 兼容舊前端邏輯
        
        # 通知所有人：有人要開槍
        emit('phase_change', {'phase': 'shoot', 'shooter': shooter_name}, room=room)
        # 通知槍手：請開槍
        emit('your_turn_to_shoot', {}, room=shooter_sid)
    
    # 2. 如果隊列空了 -> 進入下一個階段
    else:
        if game.next_phase_after_shoot == 'night':
            # 去夜晚
            game.phase = 'night'
            emit('phase_change', {'phase': 'night', 'potions': game.witch_potions}, room=room)
            auto_ready_passives(room)
            
        elif game.next_phase_after_shoot == 'day_speak':
            # 去白天發言
            game.phase = 'day_speak'
            emit('phase_change', {'phase': 'day_speak', 'dead': []}, room=room)
            emit('update_players', {'players': game.get_player_list()}, room=room)
            
        elif game.next_phase_after_shoot == 'day_vote_result':
            # 投票結束後的結算
            emit('vote_result_final', {}, room=room)

def check_win_condition(game):
    alive_wolves = 0
    alive_good = 0
    for p in game.players.values():
        if p['alive']:
            if p['role'] in ['狼人', '狼王']: alive_wolves += 1
            else: alive_good += 1
    if alive_wolves == 0: return '好人獲勝'
    if alive_wolves >= alive_good: return '狼人獲勝'
    return None

def check_and_process_night_end(room):
    game = games[room]
    total_alive = sum(1 for p in game.players.values() if p['alive'])
    ready_alive_count = 0
    for sid in game.ready_players:
        if game.players[sid]['alive']: ready_alive_count += 1
    
    if ready_alive_count >= total_alive and total_alive > 0:
        
        # [關鍵步驟 1] 在結算前，先紀錄誰被毒了 (因為 calculate 會清空 night_actions)
        poison_target_name = game.night_actions['witch_action']['poison']

        dead_names = game.calculate_night_result()
        winner = check_win_condition(game)
        
        if winner:
            emit('game_over', {'winner': winner, 'players': game.get_player_list(), 'roles': {p['name']: p['role'] for p in game.players.values()}}, room=room)
            game.phase = 'setup'
        else:
            game.shoot_queue = [] # 清空隊列
            
            for name in dead_names:
                sid = next((s for s, p in game.players.items() if p['name'] == name), None)
                if sid:
                    role = game.players[sid]['role']
                    
                    # 檢查是否為獵人或狼王
                    if role in ['獵人', '狼王']:
                        # [關鍵步驟 2] 判斷死因
                        if name == poison_target_name:
                            # 如果是被毒死的 -> 封印技能
                            emit('action_result', {'msg': f'☠️ {name} 被毒殺，無法發動技能！'}, room=room)
                        else:
                            # 正常死亡 (狼刀/投票) -> 加入開槍隊列
                            game.shoot_queue.append(sid)
            
            game.phase = 'day_speak'
            game.is_pk_round = False
            game.pk_targets = []
            
            emit('phase_change', {'phase': 'day_speak', 'dead': dead_names}, room=room)
            emit('update_players', {'players': game.get_player_list()}, room=room)

            # 處理隊列
            if game.shoot_queue:
                game.next_phase_after_shoot = 'day_speak' 
                process_shoot_queue(room)

def auto_ready_passives(room):
    game = games[room]
    for sid, p in game.players.items():
        if p['role'] in ['平民', '獵人'] or not p['alive']:
            game.ready_players.add(sid)
    check_and_process_night_end(room)

@app.route('/')
def index():
    return render_template('index.html')

@socketio.on('join')
def on_join(data):
    username = data['username']
    room = data['room']
    
    join_room(room)
    
    if room not in games:
        games[room] = Game(room)
    
    game = games[room]
    
    # --- 1. 防分身檢查 (找舊帳號) ---
    target_old_sid = None
    for sid, p in game.players.items():
        if p['name'] == username:
            target_old_sid = sid
            break
            
    # --- 2. 處理玩家資料 ---
    if target_old_sid:
        # A. 這是舊玩家 (斷線重連)
        print(f"♻️ 玩家回歸: {username}")
        
        # 繼承舊資料
        player_data = game.players.pop(target_old_sid) # 移除舊的
        game.players[request.sid] = player_data        # 綁定新的
        
        # 如果舊 ID 是房主，轉移權限
        if game.host_sid == target_old_sid:
            game.host_sid = request.sid
            
        # 如果舊 ID 有投票紀錄，轉移投票
        if target_old_sid in game.day_votes:
            vote = game.day_votes.pop(target_old_sid)
            game.day_votes[request.sid] = vote

        # 回傳加入成功 (讓前端切換到大廳)
        emit('join_success', {'room': room, 'is_host': (game.host_sid == request.sid)}, room=request.sid)

        # ---------------------------------------------------------
        # [新增] 這裡就是你缺少的「回到遊戲」邏輯！
        # 如果遊戲已經開始 (不是 setup)，要強迫前端切換畫面
        # ---------------------------------------------------------
        if game.phase != 'setup':
            # 1. 把身分證還給他 (這會觸發前端切換到遊戲介面)
            emit('game_info', {
                'role': player_data['role'], 
                'number': player_data['number']
            }, room=request.sid)
            
            # 2. 告訴他現在是什麼階段 (白天/晚上)
            emit('phase_change', {
                'phase': game.phase, 
                'dead': [], # 剛連回來先不顯示昨晚死訊，避免混亂
                'potions': game.witch_potions # 如果是晚上，要把藥水狀態給女巫
            }, room=request.sid)
            
            # 3. 如果是狼人，要把隊友名單還給他
            if player_data['role'] in ['狼人', '狼王']:
                teammates = []
                for s, p in game.players.items():
                    if p['role'] in ['狼人', '狼王'] and s != request.sid:
                        teammates.append({'name': p['name'], 'role': p['role']})
                emit('wolf_teammates', {'teammates': teammates}, room=request.sid)
                
            # 4. 補一句歡迎回來
            emit('action_result', {'msg': '⚡ 連線已恢復，回到遊戲中！'}, room=request.sid)

    else:
        # B. 這是新玩家
        game.players[request.sid] = {
            'name': username,
            'role': None,
            'alive': True,
            'number': 0,
            'is_host': False
        }
        
        # 房主判定
        if game.host_sid is None or game.host_sid not in game.players:
            game.host_sid = request.sid
            game.players[request.sid]['is_host'] = True
            
        emit('join_success', {
            'room': room, 
            'is_host': (game.host_sid == request.sid)
        }, room=request.sid)

    # 最後廣播更新列表
    emit('update_players', {'players': game.get_player_list()}, room=room)

# [新增] 踢人功能
@socketio.on('kick_player')
def on_kick(data):
    room = data['room']
    target_name = data['target_name']
    
    if room not in games: return
    game = games[room]
    
    # 權限檢查：只有房主能踢人
    if request.sid != game.host_sid: return

    # 找出被踢的人的 SID
    target_sid = next((s for s, p in game.players.items() if p['name'] == target_name), None)
    
    if target_sid:
        # 通知被踢的人
        emit('kicked', {'msg': '你已被房主踢出房間'}, room=target_sid)
        # 移除玩家
        del game.players[target_sid]
        # 更新房間列表
        emit('update_players', {'players': game.get_player_list()}, room=room)

# [新增] 重置房間功能 (救命按鈕)
@socketio.on('reset_game')
def on_reset(data):
    room = data['room']
    if room not in games: return
    game = games[room]
    
    # 權限檢查
    if request.sid != game.host_sid: return

    # 強制重置所有狀態
    game.phase = 'setup'
    game.ready_players = set()
    game.day_votes = {}
    game.night_actions = {
        'wolf_votes': {}, 'seer_has_checked': False, 
        'witch_action': {'save': False, 'poison': None}, 
        'guard_protect': None, 'witch_notified': False
    }
    game.witch_potions = {'heal': True, 'poison': True}
    game.is_pk_round = False
    game.pk_targets = []
    game.shoot_queue = []
    
    # 重置玩家狀態 (但不踢人)
    for p in game.players.values():
        p['role'] = None
        p['alive'] = True
        p['number'] = 0
    
    # 通知所有人重整頁面
    emit('game_reset', {'msg': '房主已重置遊戲！'}, room=room)

@socketio.on('start_game')
def on_start(data):
    room = data['room']
    settings = data['settings'] 
    if room in games:
        game = games[room]
        
        if request.sid != game.host_sid: return 

        if game.phase == 'setup':
            current_player_count = len(game.players)
            
            total_roles = 0
            # [修正] 嚴格檢查設定值
            for name, count in settings.items():
                try:
                    c = int(count)
                    # 1. 檢查是否為負數
                    if c < 0:
                        emit('start_failed', {'msg': f'設定錯誤：【{name}】的數量不能是負數！'}, room=request.sid)
                        return
                    total_roles += c
                except:
                    # 防止有人傳非數字進來
                    emit('start_failed', {'msg': '設定錯誤：請輸入有效的數字！'}, room=request.sid)
                    return
            
            # 2. 檢查總人數是否吻合
            if current_player_count != total_roles:
                msg = f"人數不符！無法開始。\n\n房間人數：{current_player_count} 人\n設定角色：{total_roles} 人"
                if current_player_count > total_roles:
                    msg += "\n(請增加角色或是踢出多餘玩家)"
                else:
                    msg += "\n(請減少角色或是等待更多人加入)"
                
                emit('start_failed', {'msg': msg}, room=request.sid)
                return 

            game.assign_roles(settings)
            game.phase = 'night'
            emit('phase_change', {'phase': 'night', 'potions': game.witch_potions}, room=room)
            emit('update_players', {'players': game.get_player_list()}, room=room)
            auto_ready_passives(room)

@socketio.on('night_action')
def on_action(data):
    room = data['room']
    action_type = data['type']
    target = data.get('target')
    game = games[room]
    player = game.players.get(request.sid)
    if not player or not player['role'] or not player['alive']: return 

    if action_type == 'wolf_vote' and player['role'] in ['狼人', '狼王']:
        game.night_actions['wolf_votes'][request.sid] = target
        wolf_sids = [s for s, p in game.players.items() if p['role'] in ['狼人', '狼王']]
        
        # [修改] 通知訊息加入身分標記
        for ws in wolf_sids:
            emit('wolf_notification', {'msg': f'{player["name"]} ({player["role"]}) 改投給了 {target}'}, room=ws)
        
        alive_wolf_sids = [s for s, p in game.players.items() if p['role'] in ['狼人', '狼王'] and p['alive']]
        current_votes = game.night_actions['wolf_votes']
        if all(sid in current_votes for sid in alive_wolf_sids):
            targets = [current_votes[sid] for sid in alive_wolf_sids]
            if len(set(targets)) == 1:
                consensus_target = targets[0]
                for sid in alive_wolf_sids:
                    game.ready_players.add(sid)
                    emit('force_confirm', {'msg': f'狼隊共識達成：鎖定 {consensus_target}！'}, room=sid)
                if not game.night_actions['witch_notified']:
                    witch_sid = next((s for s, p in game.players.items() if p['role'] == '女巫'), None)
                    if witch_sid: emit('witch_vision', {'victim': consensus_target}, room=witch_sid)
                    game.night_actions['witch_notified'] = True
                check_and_process_night_end(room)

    elif action_type == 'seer_check' and player['role'] == '預言家':
        if game.night_actions['seer_has_checked']:
            emit('action_result', {'msg': '已查驗過'}, room=request.sid)
            return
        target_role = next((p['role'] for s, p in game.players.items() if p['name'] == target), '未知')
        result = '狼人(壞人)' if target_role in ['狼人', '狼王'] else '好人'
        game.night_actions['seer_has_checked'] = True
        emit('seer_result', {'target': target, 'identity': result}, room=request.sid)
        game.ready_players.add(request.sid)
        check_and_process_night_end(room)

    elif action_type == 'witch_poison' and player['role'] == '女巫':
        if game.witch_potions['poison']:
            game.night_actions['witch_action']['poison'] = target
            game.witch_potions['poison'] = False
            emit('action_result', {'msg': f'已對 {target} 下毒'}, room=request.sid)
    elif action_type == 'witch_save' and player['role'] == '女巫':
        if game.night_actions['witch_notified'] and game.witch_potions['heal']:
            game.night_actions['witch_action']['save'] = True
            game.witch_potions['heal'] = False
            emit('action_result', {'msg': '已使用解藥'}, room=request.sid)

    # [修改] 守衛邏輯
    elif action_type == 'guard_protect' and player['role'] == '守衛':
        game.night_actions['guard_protect'] = target
        
        # 1. 回傳確認訊息給守衛
        emit('guard_selection', {'target': target}, room=request.sid)
        emit('action_result', {'msg': f'已選擇守護 {target} (請按結束回合確認)'}, room=request.sid)

@socketio.on('shoot_action')
def on_shoot(data):
    room = data['room']
    target = data['target']
    game = games[room]
    
    # 安全檢查
    if game.phase != 'shoot' or request.sid != game.shooter_sid: return

    # 1. 執行死亡
    killed_sid = None
    for sid, p in game.players.items():
        if p['name'] == target:
            p['alive'] = False
            killed_sid = sid
            break
            
    emit('action_result', {'msg': f'🔫 {game.players[request.sid]["name"]} 開槍帶走了 {target}！'}, room=room)
    emit('update_players', {'players': game.get_player_list()}, room=room)
    
    # 2. [關鍵] 檢查被帶走的人，是不是也能開槍 (連環爆)
    if killed_sid:
        role = game.players[killed_sid]['role']
        if role in ['狼王', '獵人']:
            # 把被帶走的人加到隊列尾端
            game.shoot_queue.append(killed_sid)

    # 3. 檢查遊戲是否結束
    winner = check_win_condition(game)
    if winner:
        emit('game_over', {'winner': winner, 'players': game.get_player_list(), 'roles': {p['name']: p['role'] for p in game.players.values()}}, room=room)
        game.phase = 'setup'
        game.shoot_queue = []
    else:
        # 4. 移除剛剛開完槍的人
        if request.sid in game.shoot_queue:
            game.shoot_queue.remove(request.sid)
        
        # 5. 呼叫隊列處理 (看看還有沒有下一個)
        process_shoot_queue(room)

@socketio.on('confirm_turn')
def on_confirm(data):
    room = data['room']
    game = games[room]
    if request.sid not in game.ready_players:
        game.ready_players.add(request.sid)
        emit('action_result', {'msg': '已確認，等待其他玩家...'}, room=request.sid)
    check_and_process_night_end(room)

@socketio.on('start_voting')
def on_start_vote(data):
    games[data['room']].phase = 'day_vote'
    games[data['room']].day_votes = {}
    emit('phase_change', {'phase': 'day_vote'}, room=data['room'])

@socketio.on('day_vote')
def on_day_vote(data):
    room = data['room']
    game = games[room]
    player = game.players.get(request.sid)

    if not player or not player['alive']: return
    
    # [新增] 嚴格檢查 1：階段必須正確
    if game.phase != 'day_vote':
        return

    # [新增] 嚴格檢查 2：鎖票 (禁止改票)
    # 如果這個人已經在投票名單裡，直接無視他的第二次請求
    if request.sid in game.day_votes:
        emit('action_result', {'msg': '❌ 你已經投過票了！無法更改。'}, room=request.sid)
        return

    # [新增] 嚴格檢查 3：PK 局當事人不能投 (這原本就有，保留著)
    if game.is_pk_round and player['name'] in game.pk_targets:
        emit('action_result', {'msg': '❌ 你是 PK 對象，不能投票！'}, room=request.sid)
        return

    game.day_votes[request.sid] = data['target']
    emit('public_vote_log', {'voter': player['name'], 'target': data['target']}, room=room)
    
    # --- [關鍵修正 1] 計算「需要多少票」才能結算 ---
    # 先算出活著的人
    alive_players = [p for p in game.players.values() if p['alive']]
    alive_count = len(alive_players)
    
    # 計算應投票人數 (Threshold)
    votes_needed = alive_count
    if game.is_pk_round:
        # 如果是 PK 局，台上的活人不能投票，所以門檻要降低
        pk_alive_count = sum(1 for p in alive_players if p['name'] in game.pk_targets)
        votes_needed = alive_count - pk_alive_count

    # 檢查票數是否足夠
    if len(game.day_votes) >= votes_needed:
        counts = {}
        for t in game.day_votes.values(): counts[t] = counts.get(t, 0) + 1
        
        valid_counts = {t: c for t, c in counts.items() if t != '棄票'}
        
        # --- [關鍵修正 2] 防止 max() 對空字典報錯 ---
        # 狀況 A: 全員棄票 (或 PK 局沒人投有效票) -> 平安日
        if not valid_counts:
            emit('vote_result', {'victim': "全員棄票，無人出局！(平安日)"}, room=room)
            emit('update_players', {'players': game.get_player_list()}, room=room)
            emit('vote_result_final', {}, room=room)
            # 重置狀態
            game.is_pk_round = False
            game.pk_targets = []
            return

        # 找出最高票數
        max_vote_num = max(valid_counts.values())
        top_targets = [t for t, c in valid_counts.items() if c == max_vote_num]
        
        # 狀況 B: 平票處理
        if len(top_targets) > 1:
            if game.is_pk_round:
                # 已經是 PK 局還平票 -> 平安日
                msg = f"PK 局再次平票 ({', '.join(top_targets)})，無人出局！"
                emit('vote_result', {'victim': msg}, room=room)
                emit('update_players', {'players': game.get_player_list()}, room=room)
                emit('vote_result_final', {}, room=room)
                
                # 結束，重置狀態
                game.is_pk_round = False
                game.pk_targets = []
                return
            else:
                # 第一次平票 -> 進入 PK
                game.day_votes = {} # 清空票箱
                game.is_pk_round = True
                game.pk_targets = top_targets # [紀錄] 誰在台上
                
                msg = f"平票 ({', '.join(top_targets)})，請針對這些人重新投票！"
                emit('vote_pk', {'targets': top_targets, 'msg': msg}, room=room)
                return

        # 狀況 C: 有明確的最高票 -> 處決
        else:
            victim_name = top_targets[0]
            victim_sid = None
            for s, p in game.players.items():
                if p['name'] == victim_name:
                    p['alive'] = False
                    victim_sid = s
                    break
            
            emit('vote_result', {'victim': f"{victim_name} 被處決了！"}, room=room)
            emit('update_players', {'players': game.get_player_list()}, room=room)

            game.is_pk_round = False 
            game.pk_targets = []
            game.shoot_queue = [] # 清空

            # [修改] 檢查死者是否能開槍
            if victim_sid:
                role = game.players[victim_sid]['role']
                if role in ['狼王', '獵人']:
                    game.shoot_queue.append(victim_sid)

            winner = check_win_condition(game)
            if winner:
                emit('game_over', {'winner': winner, 'players': game.get_player_list(), 'roles': {p['name']: p['role'] for p in game.players.values()}}, room=room)
                game.phase = 'setup'
            else:
                if game.shoot_queue:
                    game.next_phase_after_shoot = 'day_vote_result' # 開完槍後顯示入夜按鈕
                    process_shoot_queue(room)
                else:
                    emit('vote_result_final', {}, room=room)

@socketio.on('go_to_night')
def on_go_night(data):
    room = data['room']
    game = games[room]
    game.phase = 'night'
    emit('phase_change', {'phase': 'night', 'potions': game.witch_potions}, room=room)
    auto_ready_passives(room)

if __name__ == '__main__':
    socketio.run(app, debug=True)