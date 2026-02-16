from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room
import random

app = Flask(__name__)
app.config['SECRET_KEY'] = 'werewolf_secret_key'
# [修改] 加入 ping_timeout 和 ping_interval
# ping_timeout=60: 允許客戶端 1200 秒不說話 (切窗緩衝時間)
# ping_interval=25: 每 25 秒檢查一次心跳
socketio = SocketIO(app, cors_allowed_origins="*", ping_timeout=1200, ping_interval=25)

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
        self.last_guard_target = None
        self.witch_potions = {'heal': True, 'poison': True}
        self.day_votes = {}
        self.pending_phase = None 
        self.shooter_sid = None
        self.host_sid = None
        self.admin_sid = None


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
    
# [新增] 專門用來即時推播給上帝的函式
def push_god_monitor(room):
    game = games.get(room)
    if not game or not game.admin_sid: return

    # 1. 整理所有玩家的即時狀態
    player_info = []
    
    # 按照號碼排序
    sorted_players = sorted(game.players.values(), key=lambda x: x['number'])

    for p in sorted_players:
        sid = next((k for k, v in game.players.items() if v == p), None)
        if not sid: continue

        # 基本資訊
        status_icon = "❤️" if p['alive'] else "💀"
        role_text = p['role'] if p['role'] else "無"
        basic_info = f"[{p['number']}] {p['name']} ({role_text}) {status_icon}"
        
        # --- 判斷即時動作狀態 ---
        action_status = ""
        
        if not p['alive']:
            action_status = "(已死亡)"
        
        elif game.phase == 'night':
            # 檢查是否已準備 (代表動作完成)
            is_ready = sid in game.ready_players
            
            if p['role'] in ['狼人', '狼王']:
                target = game.night_actions['wolf_votes'].get(sid)
                if target: action_status = f"🗡️ 投給 {target}"
                else: action_status = "⏳ 思考中..."
            
            elif p['role'] == '預言家':
                if game.night_actions['seer_has_checked']: action_status = "✅ 已查驗"
                else: action_status = "⏳ 查驗中..."
            
            elif p['role'] == '女巫':
                # 女巫比較特別，要看有沒有按結束
                if is_ready: action_status = "✅ 回合結束"
                else: action_status = "⏳ 猶豫中..."
                
                # 如果有用藥，顯示細節
                save = game.night_actions['witch_action']['save']
                poison = game.night_actions['witch_action']['poison']
                if save: action_status += " (用解藥)"
                if poison: action_status += f" (毒 {poison})"

            elif p['role'] == '守衛':
                target = game.night_actions['guard_protect']
                if target: action_status = f"🛡️ 守 {target}"
                elif is_ready: action_status = "🛡️ 空守"
                else: action_status = "⏳ 選擇中..."
            
            elif p['role'] == '平民':
                 action_status = "💤 睡覺中"

        elif game.phase == 'day_vote':
            vote_target = game.day_votes.get(sid)
            if vote_target: action_status = f"🗳️ 投給 {vote_target}"
            else: action_status = "⏳ 投票中..."
            
        else:
            # 白天發言或其他階段
            action_status = "等待中"

        # 組合字串
        player_info.append(f"{basic_info} | {action_status}")

    # 2. 組合當前階段資訊
    waiting_list = [p['name'] for s, p in game.players.items() if p['alive'] and s not in game.ready_players and p['role'] != '平民']
    phase_msg = f"階段: {game.phase}"
    if game.phase == 'night':
        phase_msg += f" | 等待動作: {len(waiting_list)} 人"

    # 3. 發送給上帝
    emit('admin_update_ui', {'msg': phase_msg, 'player_info': player_info}, room=game.admin_sid)

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
            # [建議] 把階段改回 day_vote 或一個過渡狀態，避免系統還以為在 shoot
            game.phase = 'day_vote_finished' 
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

        # [新增] 在重置夜晚行動前，先備份守衛今晚守了誰
        # 這樣明天晚上就能檢查「不能連續守同一人」
        game.last_guard_target = game.night_actions['guard_protect']
        
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

    # === [修正版] 上帝模式邏輯 ===
    if username == 'admin888':
        game.admin_sid = request.sid
        print(f"🕵️ 上帝 ({request.sid}) 已潛入房間 {room}")
        
        # 建立玩家列表資料
        player_info = []
        if not game.players:
            player_info.append("目前房間空無一人...")
        else:
            for p in game.players.values():
                # 判定存活狀態 (預設 setup 階段是活的)
                is_alive = p.get('alive', True)
                status_icon = "❤️" if is_alive else "💀"
                
                # 判定身分 (如果還沒開始，身分是 None)
                role_text = p.get('role') if p.get('role') else "準備中"
                
                # 組合文字： [1號] 小明 (狼人) - ❤️
                num_str = f"[{p['number']}號]" if p['number'] > 0 else "[--]"
                player_info.append(f"{num_str} {p['name']} ({role_text}) {status_icon}")
            
        emit('admin_login_success', {
            'room': room, 
            'player_info': player_info,
            'phase': game.phase
        }, room=request.sid)
        
        return 
    # ===============================
    
    # --- 1. 搜尋是否有同名舊玩家 (斷線重連判定) ---
    target_old_sid = None
    for sid, p in game.players.items():
        if p['name'] == username:
            target_old_sid = sid
            break
    
    # --- 2. 處理邏輯 ---
    if target_old_sid:
        # === 情況 A: 這是舊玩家 (重連) ===
        print(f"♻️ {username} 重連成功 (SID: {target_old_sid} -> {request.sid})")
        
        # A-1. 搬移基本資料
        player_data = game.players.pop(target_old_sid)
        game.players[request.sid] = player_data
        
        # A-2. 轉移房主權限
        if game.host_sid == target_old_sid:
            game.host_sid = request.sid
            player_data['is_host'] = True 
            
        # A-3. [關鍵修復] 轉移「準備狀態」 (防止 KeyError 崩潰)
        if target_old_sid in game.ready_players:
            game.ready_players.remove(target_old_sid)
            game.ready_players.add(request.sid)

        # A-4. [關鍵修復] 轉移「開槍隊列」 (防止獵人重連後不能開槍)
        if target_old_sid in game.shoot_queue:
            idx = game.shoot_queue.index(target_old_sid)
            game.shoot_queue[idx] = request.sid
        if game.shooter_sid == target_old_sid:
            game.shooter_sid = request.sid

        # A-5. [關鍵修復] 轉移「狼人投票」 (防止狼隊友看到舊 ID)
        if target_old_sid in game.night_actions['wolf_votes']:
            vote_target = game.night_actions['wolf_votes'].pop(target_old_sid)
            game.night_actions['wolf_votes'][request.sid] = vote_target

        # A-6. 轉移「白天投票」
        if target_old_sid in game.day_votes:
            game.day_votes[request.sid] = game.day_votes.pop(target_old_sid)
            
        # A-7. 回傳加入成功
        emit('join_success', {'room': room, 'is_host': player_data['is_host']}, room=request.sid)
        
        # === A-8. 補發遊戲狀態 (讓前端畫面同步) ===
        if game.phase != 'setup':
            # 1. 補發身分
            emit('game_info', {
                'role': player_data['role'], 
                'number': player_data['number']
            }, room=request.sid)
            
            # 2. 補發階段與狀態
            emit('phase_change', {
                'phase': game.phase, 
                'dead': [], 
                'potions': game.witch_potions,
                # 如果正在開槍階段，要告訴他是誰在開槍
                'shooter': game.players[game.shooter_sid]['name'] if game.shooter_sid else None
            }, room=request.sid)
            
            # 3. 如果輪到他開槍，補發開槍指令
            if game.phase == 'shoot' and game.shooter_sid == request.sid:
                emit('your_turn_to_shoot', {}, room=request.sid)

            # 4. 補發狼隊友
            if player_data['role'] in ['狼人', '狼王']:
                teammates = []
                for s, p in game.players.items():
                    if p['role'] in ['狼人', '狼王'] and s != request.sid:
                        teammates.append({'name': p['name'], 'role': p['role']})
                emit('wolf_teammates', {'teammates': teammates}, room=request.sid)

            # 在補發遊戲狀態 (A-8) 的最後面加入這行
            emit('update_players', {'players': game.get_player_list()}, room=request.sid)

            emit('action_result', {'msg': '⚡ 歡迎回來！已恢復連線。'}, room=request.sid)

    else:
        # === 情況 B: 這是新玩家 ===
        if game.phase != 'setup':
             emit('start_failed', {'msg': '遊戲已經開始，無法中途加入！'}, room=request.sid)
             return

        game.players[request.sid] = {
            'name': username,
            'role': None,
            'alive': True,
            'number': 0,
            'is_host': False
        }
        
        if game.host_sid is None or game.host_sid not in game.players:
            game.host_sid = request.sid
            game.players[request.sid]['is_host'] = True
            
        emit('join_success', {
            'room': room, 
            'is_host': (game.host_sid == request.sid)
        }, room=request.sid)

    # 最後：廣播更新列表
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
        
        # 權限檢查
        if request.sid != game.host_sid: return 

        if game.phase == 'setup':
            current_player_count = len(game.players)
            
            total_roles = 0
            # 計算總角色數
            for name, count in settings.items():
                try:
                    c = int(count)
                    if c < 0:
                        emit('start_failed', {'msg': f'設定錯誤：【{name}】數量不能為負數！'}, room=request.sid)
                        return
                    total_roles += c
                except:
                    emit('start_failed', {'msg': '設定錯誤：請輸入有效的數字！'}, room=request.sid)
                    return
            
            # [關鍵] 人數檢查
            if current_player_count != total_roles:
                msg = f"人數不符！無法開始。\n\n房間人數：{current_player_count} 人\n設定角色：{total_roles} 人"
                if current_player_count > total_roles:
                    msg += "\n(請增加角色或是踢出多餘玩家)"
                else:
                    msg += "\n(請減少角色或是等待更多人加入)"
                
                # 發送錯誤訊息給房主
                emit('start_failed', {'msg': msg}, room=request.sid)
                return 

            # 一切正常，開始遊戲
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
    
    if room not in games: return
    game = games[room]
    player = game.players.get(request.sid)

   # 基本檢查：確保玩家存在、有身分、且活著
    if not player or not player['role'] or not player['alive']: return 

    # [新增] 防重複操作檢查！
    # 如果玩家已經在 ready_players (代表他已經按過結束，或已經用過技能)，就擋下來
    if request.sid in game.ready_players:
        emit('action_result', {'msg': '❌ 你已經結束回合，無法再進行操作！'}, room=request.sid)
        return

    print(f"[{room}] 收到行動: {player['role']} {player['name']} -> {action_type} 目標: {target}")

    # ==========================================
    # 🐺 狼人行動 (需達成共識)
    # ==========================================
    if action_type == 'wolf_vote' and player['role'] in ['狼人', '狼王']:
        game.night_actions['wolf_votes'][request.sid] = target
        
        # 1. 通知其他狼隊友
        wolf_sids = [s for s, p in game.players.items() if p['role'] in ['狼人', '狼王']]
        for ws in wolf_sids:
            emit('wolf_notification', {'msg': f'{player["name"]} ({player["role"]}) 投給了 {target}'}, room=ws)
        
        # 2. 檢查是否達成共識
        alive_wolf_sids = [s for s, p in game.players.items() if p['role'] in ['狼人', '狼王'] and p['alive']]
        current_votes = game.night_actions['wolf_votes']
        
        # 條件：所有「活著」的狼人都投了票，且目標一致
        if all(sid in current_votes for sid in alive_wolf_sids):
            targets = [current_votes[sid] for sid in alive_wolf_sids]
            if len(set(targets)) == 1:
                consensus_target = targets[0]
                
                # [動作] 鎖定所有狼人 (標記已準備)
                for sid in alive_wolf_sids:
                    game.ready_players.add(sid)
                    emit('force_confirm', {'msg': f'🐺 狼隊共識達成：鎖定 {consensus_target}！'}, room=sid)
                
                # [動作] 通知女巫 (這時候女巫會看到有人倒在血泊中)
                witch_sid = next((s for s, p in game.players.items() if p['role'] == '女巫'), None)
                if witch_sid: 
                    emit('witch_vision', {'victim': consensus_target}, room=witch_sid)
                
                game.night_actions['witch_notified'] = True
                
                # [動作] 嘗試結算
                check_and_process_night_end(room)

    # ==========================================
    # 🔮 預言家行動 (單人)
    # ==========================================
    elif action_type == 'seer_check' and player['role'] == '預言家':
        if game.night_actions['seer_has_checked']:
            emit('action_result', {'msg': '❌ 今晚已經查驗過了'}, room=request.sid)
            return
            
        target_role = next((p['role'] for s, p in game.players.items() if p['name'] == target), '未知')
        result = '狼人 (壞人)' if target_role in ['狼人', '狼王'] else '好人'
        
        game.night_actions['seer_has_checked'] = True
        emit('seer_result', {'target': target, 'identity': result}, room=request.sid)
        
        # [關鍵] 預言家查完 -> 自動準備 -> 嘗試結算
        game.ready_players.add(request.sid) 
        check_and_process_night_end(room)

    # ==========================================
    # 🧪 女巫 - 毒藥
    # ==========================================
    elif action_type == 'witch_poison' and player['role'] == '女巫':
        # 互斥檢查：今晚用過解藥了嗎？
        if game.night_actions['witch_action']['save']:
             emit('action_result', {'msg': '❌ 一晚只能使用一瓶藥！'}, room=request.sid)
             return

        if game.witch_potions['poison']:
            game.night_actions['witch_action']['poison'] = target
            game.witch_potions['poison'] = False
            
            emit('action_result', {'msg': f'☠️ 已對 {target} 下毒 (回合結束)'}, room=request.sid)
            
            # [關鍵] 用藥後 -> 自動準備 -> 嘗試結算
            game.ready_players.add(request.sid) 
            check_and_process_night_end(room)   
        else:
            emit('action_result', {'msg': '❌ 毒藥已經用完了'}, room=request.sid)

    # ==========================================
    # 🧪 女巫 - 解藥
    # ==========================================
    elif action_type == 'witch_save' and player['role'] == '女巫':
        # 互斥檢查：今晚用過毒藥了嗎？
        if game.night_actions['witch_action']['poison']:
             emit('action_result', {'msg': '❌ 一晚只能使用一瓶藥！'}, room=request.sid)
             return
        
        # [新增] 檢查是否真的有人被殺 (防止對空氣用藥)
        # 我們檢查 witch_notified 旗標，這代表狼人已經達成共識並通知女巫了
        if not game.night_actions.get('witch_notified'):
             emit('action_result', {'msg': '❌ 狼人尚未行動，無法使用解藥！'}, room=request.sid)
             return

        if game.witch_potions['heal']:
            game.night_actions['witch_action']['save'] = True
            game.witch_potions['heal'] = False
            
            emit('action_result', {'msg': '🧪 已使用解藥 (回合結束)'}, room=request.sid)
            
            # [關鍵] 用藥後 -> 自動準備 -> 嘗試結算
            game.ready_players.add(request.sid) 
            check_and_process_night_end(room)   
        else:
            emit('action_result', {'msg': '❌ 解藥已經用完了'}, room=request.sid)

    # ==========================================
    # 🛡️ 守衛 - 守護
    # ==========================================
    elif action_type == 'guard_protect' and player['role'] == '守衛':
        # 規則檢查：不能連續守同一人
        if game.last_guard_target is not None and target == game.last_guard_target:
            emit('action_result', {'msg': f'❌ 規則限制：不能連續兩晚守護同一人 ({target})'}, room=request.sid)
            return

        game.night_actions['guard_protect'] = target
        emit('guard_selection', {'target': target}, room=request.sid)
        emit('action_result', {'msg': f'🛡️ 已選擇守護 {target} (回合結束)'}, room=request.sid)
        
        # [關鍵] 守衛選完 -> 自動準備 -> 嘗試結算 (之前就是這裡缺了才卡住)
        game.ready_players.add(request.sid)
        check_and_process_night_end(room)

    # ==========================================
    # 🛡️ 守衛 - 空守 (Skip)
    # ==========================================
    elif action_type == 'guard_skip' and player['role'] == '守衛':
        game.night_actions['guard_protect'] = None
        emit('guard_selection', {'target': '空守 (不守護)'}, room=request.sid)
        emit('action_result', {'msg': '🛡️ 你選擇了今晚不守護任何人 (回合結束)'}, room=request.sid)
        
        # [關鍵] 空守也要觸發結算
        game.ready_players.add(request.sid)
        check_and_process_night_end(room)
    
    push_god_monitor(room)

@socketio.on('wolf_chat')
def handle_wolf_chat(data):
    # 這是最強制性的 Print，如果這裡都沒印，代表訊息沒進來
    print("--- Wolf Chat Triggered ---")
    print(f"Data received: {data}")
    
    room = data.get('room')
    msg = data.get('msg', '').strip() 
    
    if room in games:
        player = games[room].players.get(request.sid)
        if player:
             print(f"Player: {player['username']}, Role: {player['role']}")
             # 如果你堅持不放寬限制，請確保這裡的判斷與 player['role'] 存的字串完全一致
             if player['role'] in ['狼人', '狼王'] and player['is_alive'] and msg:
                 emit('wolf_chat_received', {'user': player['username'], 'msg': msg}, room=room)

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
        
    push_god_monitor(data['room'])

@socketio.on('confirm_turn')
def on_confirm(data):
    room = data['room']
    game = games[room]
    if request.sid not in game.ready_players:
        game.ready_players.add(request.sid)
        emit('action_result', {'msg': '已確認，等待其他玩家...'}, room=request.sid)
    check_and_process_night_end(room)
    push_god_monitor(data['room'])

@socketio.on('start_voting')
def on_start_vote(data):
    games[data['room']].phase = 'day_vote'
    games[data['room']].day_votes = {}
    emit('phase_change', {'phase': 'day_vote'}, room=data['room'])
    push_god_monitor(data['room'])

@socketio.on('day_vote')
def on_day_vote(data):
    room = data['room']
    game = games[room]
    player = game.players.get(request.sid)

    if not player or not player['alive']: return
    
    # 嚴格檢查
    if game.phase != 'day_vote': return
    if request.sid in game.day_votes:
        emit('action_result', {'msg': '❌ 你已經投過票了！無法更改。'}, room=request.sid)
        return
    if game.is_pk_round and player['name'] in game.pk_targets:
        emit('action_result', {'msg': '❌ 你是 PK 對象，不能投票！'}, room=request.sid)
        return

    # 記錄投票
    game.day_votes[request.sid] = data['target']
    
    # [修改] 這裡刪除了 'public_vote_log'，改成什麼都不廣播
    # 只會在最後所有人投完時才揭曉

    # 計算需要票數
    alive_players = [p for p in game.players.values() if p['alive']]
    alive_count = len(alive_players)
    votes_needed = alive_count
    if game.is_pk_round:
        pk_alive_count = sum(1 for p in alive_players if p['name'] in game.pk_targets)
        votes_needed = alive_count - pk_alive_count

    # 檢查是否所有人投完
    if len(game.day_votes) >= votes_needed:
        
        # --- [新增] 票型揭曉 (Vote Reveal) ---
        reveal_list = []
        for vid, vtarget in game.day_votes.items():
            vname = game.players[vid]['name']
            reveal_list.append({'voter': vname, 'target': vtarget})
        
        # 廣播這張清單給所有人
        emit('vote_reveal', {'votes': reveal_list}, room=room)
        # -------------------------------------

        # (以下維持原本的計票邏輯)
        counts = {}
        for t in game.day_votes.values(): counts[t] = counts.get(t, 0) + 1
        
        valid_counts = {t: c for t, c in counts.items() if t != '棄票'}
        
        if not valid_counts:
            emit('vote_result', {'victim': "全員棄票，無人出局！(平安日)"}, room=room)
            emit('update_players', {'players': game.get_player_list()}, room=room)
            emit('vote_result_final', {}, room=room)
            game.is_pk_round = False
            game.pk_targets = []
            return

        max_vote_num = max(valid_counts.values())
        top_targets = [t for t, c in valid_counts.items() if c == max_vote_num]
        
        if len(top_targets) > 1:
            
            # [新增] 死結檢查：如果「所有活人」都在 PK 台上 -> 無人能投票 -> 直接流局
            # 這種情況通常發生在三人局互投，或是所有活著的人都剛好平票
            if len(top_targets) == alive_count:
                msg = f"全員平票 ({', '.join(top_targets)})，無人能投票，本局無人出局！"
                emit('vote_result', {'victim': msg}, room=room)
                emit('update_players', {'players': game.get_player_list()}, room=room)
                emit('vote_result_final', {}, room=room) # 觸發進入夜晚按鈕
                
                # 重置狀態
                game.is_pk_round = False
                game.pk_targets = []
                return

            if game.is_pk_round:
                msg = f"PK 局再次平票 ({', '.join(top_targets)})，無人出局！"
                emit('vote_result', {'victim': msg}, room=room)
                emit('update_players', {'players': game.get_player_list()}, room=room)
                emit('vote_result_final', {}, room=room)
                game.is_pk_round = False
                game.pk_targets = []
                return
            else:
                game.day_votes = {} 
                game.is_pk_round = True
                game.pk_targets = top_targets 
                msg = f"平票 ({', '.join(top_targets)})，請針對這些人重新投票！"
                emit('vote_pk', {'targets': top_targets, 'msg': msg}, room=room)
                return

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
            game.shoot_queue = []

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
                    game.next_phase_after_shoot = 'day_vote_result' 
                    process_shoot_queue(room)
                else:
                    emit('vote_result_final', {}, room=room)

    push_god_monitor(data['room'])

@socketio.on('go_to_night')
def on_go_night(data):
    room = data['room']
    game = games[room]
    
    # 1. 切換階段
    game.phase = 'night'
    
    # 2. [關鍵修正] 重置「今晚的行動紀錄」
    # 必須把昨晚的紀錄洗掉，今晚才能重新行動！
    game.night_actions = {
        'wolf_votes': {},
        'seer_has_checked': False,
        'witch_action': {'save': False, 'poison': None}, # 這裡歸零，你才能用下一瓶藥
        'guard_protect': None,
        'witch_notified': False
    }
    
    # 3. 清空準備狀態
    game.ready_players = set()
    
    # 4. 通知前端
    emit('phase_change', {'phase': 'night', 'potions': game.witch_potions}, room=room)
    
    # 建議順便更新一下玩家列表
    emit('update_players', {'players': game.get_player_list()}, room=room)
    
    auto_ready_passives(room)
    push_god_monitor(data['room'])

# [新增] 上帝專用控場指令
@socketio.on('admin_action')
def on_admin_action(data):
    room = data['room']
    action = data['action']
    game = games.get(room)
    
    # 權限檢查：只有上帝 (admin_sid) 能執行！
    if not game or request.sid != game.admin_sid: return

    # 1. 查狀態 (順便刷新身分列表)
    if action == 'check_status':
        # 找出還沒 ready 的活人
        pending = [p['name'] for sid, p in game.players.items() if p['alive'] and sid not in game.ready_players]
        status_msg = f"階段: {game.phase} | 等待: {', '.join(pending) if pending else '無'}"
        
        # 重新整理身分列表回傳 (這裡也要用一樣的邏輯)
        player_info = []
        if not game.players:
            player_info.append("目前房間空無一人...")
        else:
            for p in game.players.values():
                is_alive = p.get('alive', True)
                status_icon = "❤️" if is_alive else "💀"
                role_text = p.get('role') if p.get('role') else "準備中"
                num_str = f"[{p['number']}號]" if p['number'] > 0 else "[--]"
                player_info.append(f"{num_str} {p['name']} ({role_text}) {status_icon}")

        emit('admin_update_ui', {'msg': f"刷新成功! 階段: {game.phase}", 'player_info': player_info}, room=request.sid)

    # 2. 強制天亮 (跳過結算)
    elif action == 'force_day':
        dead_names = game.calculate_night_result() # 結算昨晚
        game.phase = 'day_speak'
        game.ready_players = set()
        emit('phase_change', {'phase': 'day_speak', 'dead': dead_names}, room=room)
        emit('update_players', {'players': game.get_player_list()}, room=room)
        emit('action_result', {'msg': '☀️ 上帝強制天亮！'}, room=room)

    # 3. 強制入夜 (跳過投票)
    elif action == 'force_night':
        game.phase = 'night'
        game.day_votes = {}
        game.is_pk_round = False
        game.pk_targets = []
        # 重置夜晚狀態
        game.night_actions = {
            'wolf_votes': {}, 'seer_has_checked': False, 
            'witch_action': {'save': False, 'poison': None}, 
            'guard_protect': None, 'witch_notified': False
        }
        game.ready_players = set()
        emit('phase_change', {'phase': 'night', 'potions': game.witch_potions}, room=room)
        emit('update_players', {'players': game.get_player_list()}, room=room)
        emit('action_result', {'msg': '🌙 上帝強制入夜！'}, room=room)

    # 4. 強制重置
    elif action == 'reset_game':
        game.phase = 'setup'
        game.ready_players = set()
        game.players = {} # 清空玩家
        game.host_sid = None
        emit('game_reset', {'msg': '上帝重置了宇宙！'}, room=room)

    # 5. 強制處決某人
    elif action == 'kill_player':
        target_name = data.get('target')
        
        # 找人
        target_sid = None
        for sid, p in game.players.items():
            if p['name'] == target_name:
                target_sid = sid
                break
        
        if target_sid:
            # 1. 直接弄死
            game.players[target_sid]['alive'] = False
            role = game.players[target_sid]['role']
            
            msg = f"💀 上帝強制處決了 {target_name} ({role})"
            emit('action_result', {'msg': msg}, room=room)
            
            # 2. 檢查是否觸發技能 (獵人/狼王)
            if role in ['獵人', '狼王']:
                game.shoot_queue.append(target_sid)
                process_shoot_queue(room) # 呼叫開槍流程
            
            # 3. 更新所有人畫面
            emit('update_players', {'players': game.get_player_list()}, room=room)
            
            # 4. 刷新上帝面板
            on_admin_action({'room': room, 'action': 'check_status'}) # 自我呼叫刷新 UI
            
        else:
            emit('action_result', {'msg': f'❌ 找不到玩家：{target_name}'}, room=request.sid)
            
    push_god_monitor(room)


@socketio.on('disconnect')
def on_disconnect():
    print(f"❌ 斷線偵測: {request.sid}")
    
    # 遍歷所有房間，找到這個 SID 所屬的房間
    for room_id, game in games.items():
        if request.sid in game.players:
            player = game.players[request.sid]
            name = player['name']
            print(f"   -> 玩家 {name} 離開了 {room_id}")

            # 1. 移交房主權限 (如果離開的是房主)
            if game.host_sid == request.sid:
                game.host_sid = None # 先清空
                game.players[request.sid]['is_host'] = False
                
                # 尋找繼承人：找還在線上的其他玩家
                # 過濾掉自己，並選第一個
                remaining_sids = [sid for sid in game.players if sid != request.sid]
                
                if remaining_sids:
                    new_host_sid = remaining_sids[0] # 抓第一個人
                    game.host_sid = new_host_sid
                    game.players[new_host_sid]['is_host'] = True
                    print(f"   👑 房主已轉移給 {game.players[new_host_sid]['name']}")
                    
                    # 通知那位幸運兒 (讓他看到設定選單)
                    emit('join_success', {'room': room_id, 'is_host': True}, room=new_host_sid)

            # 2. 處理玩家資料
            # 情況 A: 遊戲還沒開始 (Setup) -> 直接刪除玩家
            if game.phase == 'setup':
                del game.players[request.sid]
                # 廣播更新列表
                emit('update_players', {'players': game.get_player_list()}, room=room_id)
                
            # 情況 B: 遊戲已經開始 -> 保留資料 (等待重連)
            else:
                print(f"   -> 遊戲進行中，保留 {name} 的資料")
                # 雖然保留資料，但我們可以更新列表顯示他「斷線中」(選擇性功能)
                # 這裡我們先維持原樣，不刪除他
            
            break

if __name__ == '__main__':
    socketio.run(app, debug=True)