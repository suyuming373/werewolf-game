const socket = io();
let myRoom = "";
let myName = "";
let myRole = "";
let isAlive = true; 
let currentPhase = "setup"; 
let amIHost = false; // [修復] 這裡補上了房主變數宣告！

// ---------------- 按鈕功能區 ----------------

function joinGame() {
    const username = document.getElementById('username').value;
    const room = document.getElementById('room').value;

    if (username && room) {
        myName = username;
        myRoom = room;
        
        // 把名字和房號存在瀏覽器裡 (F5 重連用)
        localStorage.setItem('ww_username', username);
        localStorage.setItem('ww_room', room);

        socket.emit('join', {username: username, room: room});
    } else {
        alert("請輸入暱稱和房號！");
    }
}

function startGame() {
    const settings = {
        '狼人': document.getElementById('role-wolf').value,
        '狼王': document.getElementById('role-wolfking').value,
        '預言家': document.getElementById('role-seer').value,
        '女巫': document.getElementById('role-witch').value,
        '守衛': document.getElementById('role-guard').value,
        '獵人': document.getElementById('role-hunter').value,
        '平民': document.getElementById('role-villager').value
    };
    socket.emit('start_game', {room: myRoom, settings: settings});
}

function confirmTurn() { 
    if (!isAlive) return;
    socket.emit('confirm_turn', {room: myRoom}); 
    document.getElementById('btn-end-turn').disabled = true; 
    document.getElementById('btn-end-turn').innerText = "已確認 / 等待其他玩家..."; 
}

function startVoting() { socket.emit('start_voting', {room: myRoom}); }
function goToNight() { socket.emit('go_to_night', {room: myRoom}); }

let selectedAction = null; // 記錄當前選中的技能 (女巫用)

function usePotion(type) { 
    if (!isAlive) return;
    selectedAction = type; // 標記為正在使用藥水
    
    // 視覺回饋
    if (type === 'save') {
         document.getElementById('btn-save').innerText = "請點擊頭像使用解藥...";
         document.getElementById('btn-save').disabled = true;
    }
    addLog("[系統] 請點擊一名玩家頭像來發動技能");
    
    // 暫時解鎖所有玩家按鈕讓女巫點選
    document.querySelectorAll('.player-btn').forEach(btn => {
        btn.disabled = false;
        btn.style.cursor = "pointer";
    });
}

function resetActionButtons() {
    // 重置按鈕狀態
    selectedAction = null;
    document.getElementById('btn-save').innerText = "使用解藥";
}

// 棄票函式
function voteAbstain() {
    if (!isAlive) return;
    // 送出目標為 "棄票"
    socket.emit('day_vote', {room: myRoom, target: '棄票'});
    addLog("你選擇了棄票");
    
    // 鎖定所有按鈕
    document.querySelectorAll('.player-btn').forEach(b => b.disabled = true);
    document.getElementById('btn-abstain').disabled = true;
}

// 踢人函式
function kickPlayer(targetName) {
    if (confirm(`確定要踢出 ${targetName} 嗎？`)) {
        socket.emit('kick_player', {room: myRoom, target_name: targetName});
    }
}

// 重置房間
function resetGame() {
    if (confirm("確定要強制重置房間嗎？\n(所有遊戲進度將會遺失)")) {
        socket.emit('reset_game', {room: myRoom});
    }
}

// ---------------- 監聽與邏輯區 ----------------

// [修復] 加入成功 (這一段原本少了，導致進不去大廳)
socket.on('join_success', (data) => {
    console.log("加入成功！房主身分:", data.is_host);
    amIHost = data.is_host;
    
    // 切換到大廳畫面
    document.getElementById('login-view').classList.add('hidden');
    document.getElementById('lobby-view').classList.remove('hidden');

    // 如果我是房主，顯示設定區；如果是路人，顯示等待訊息
    if (amIHost) {
        document.getElementById('host-settings').classList.remove('hidden');
        document.getElementById('guest-waiting-msg').classList.add('hidden');
    } else {
        document.getElementById('host-settings').classList.add('hidden');
        document.getElementById('guest-waiting-msg').classList.remove('hidden');
    }
});

socket.on('wolf_teammates', (data) => {
    let msg = "🐺 你的狼隊友：\n";
    if (data.teammates.length === 0) {
        msg += "(無，你是孤狼)";
    } else {
        data.teammates.forEach(t => {
            msg += `- ${t.name} [${t.role}]\n`;
        });
    }
    addLog(msg, "wolf-msg"); 
});

socket.on('kicked', (data) => {
    alert(data.msg);
    location.reload(); 
});

socket.on('start_failed', (data) => {
    alert(data.msg);
});

socket.on('game_reset', (data) => {
    alert(data.msg);
    location.reload(); 
});

socket.on('public_vote_log', (data) => {
    addLog(`🗳️ ${data.voter} 投給了 ${data.target}`);
});

socket.on('update_players', (data) => {
    // 找出我是誰，更新存活狀態
    const me = data.players.find(p => p.name === myName);
    if (me) {
        isAlive = me.alive;
        amIHost = me.is_host; // 同步房主權限
        
        // 如果重連回來發現自己死了，更新介面
        if (!isAlive) {
            document.getElementById('my-role-info').innerText += " (已死亡)";
            document.getElementById('my-role-info').style.color = "gray";
            // 鎖定按鈕
            document.querySelectorAll('.player-btn').forEach(b => b.disabled = true);
        }
    }

    const list = document.getElementById('player-list');
    list.innerHTML = "";
    
    // 更新等待區列表
    data.players.forEach(p => {
        let li = document.createElement('li');
        let text = p.number > 0 ? `[${p.number}] ${p.name}` : p.name;
        
        if (p.is_host) text += " 👑";
        
        li.innerText = text;

        // 踢人按鈕 (只有房主看得到，且不能踢自己，且必須在準備階段)
        if (amIHost && p.name !== myName && currentPhase === 'setup') {
            let kickBtn = document.createElement('button');
            kickBtn.innerText = "❌";
            kickBtn.style.marginLeft = "10px";
            kickBtn.style.padding = "2px 6px";
            kickBtn.style.fontSize = "0.8em";
            kickBtn.style.background = "#d32f2f";
            kickBtn.style.width = "auto"; 
            kickBtn.onclick = () => kickPlayer(p.name);
            li.appendChild(kickBtn);
        }

        list.appendChild(li);
    });

    // 如果在大廳，根據是否為房主顯示設定
    if (currentPhase === 'setup') {
        if (amIHost) {
            document.getElementById('host-settings').classList.remove('hidden');
            document.getElementById('guest-waiting-msg').classList.add('hidden');
        } else {
            document.getElementById('host-settings').classList.add('hidden');
            document.getElementById('guest-waiting-msg').classList.remove('hidden');
        }
    }

    const gameList = document.getElementById('game-players');
    gameList.innerHTML = "";
    data.players.forEach(p => {
        if (p.alive) {
            let btn = document.createElement('button');
            btn.innerHTML = `<span class="number-badge">${p.number}</span> ${p.name}`;
            btn.className = "player-btn";
            btn.onclick = () => handlePlayerClick(p.name);
            // 如果是白天發言階段，按鈕要鎖住
            if (currentPhase === 'day_speak') btn.disabled = true;
            gameList.appendChild(btn);
        } else {
            let div = document.createElement('div');
            div.innerHTML = `<span class="number-badge" style="background:#555">${p.number}</span> ${p.name} (死亡)`;
            div.className = "dead";
            div.style.padding = "10px";
            gameList.appendChild(div);
        }
    });
});

socket.on('game_over', (data) => {
    let msg = `🏆 遊戲結束！\n\n${data.winner}！！！\n\n=== 角色揭曉 ===\n`;
    for (const [name, role] of Object.entries(data.roles)) {
        msg += `${name}: ${role}\n`;
    }
    alert(msg);
    location.reload(); 
});

socket.on('game_info', (data) => {
    myRole = data.role;
    isAlive = true; 
    document.getElementById('lobby-view').classList.add('hidden');
    document.getElementById('game-view').classList.remove('hidden');
    document.getElementById('my-role-info').innerText = `[${data.number}號] 身分：${myRole}`;
    
    if (myRole === '女巫') {
        document.getElementById('witch-area').classList.remove('hidden');
        document.getElementById('victim-name').innerText = "等待狼人行動...";
        document.getElementById('btn-save').disabled = true;
    }
    addLog(`遊戲開始！你是 ${myRole}`);
});

socket.on('guard_selection', (data) => {
    const targetSpan = document.getElementById('guard-target');
    if (targetSpan) {
        targetSpan.innerText = data.target;
    }
});

socket.on('phase_change', (data) => {
    const lastPhase = currentPhase;
    currentPhase = data.phase;
    
    const title = document.getElementById('phase-title');
    const endBtn = document.getElementById('btn-end-turn');
    const voteBtn = document.getElementById('btn-start-vote');
    const nightBtn = document.getElementById('btn-go-night');
    const abstainBtn = document.getElementById('btn-abstain');
    const witchArea = document.getElementById('witch-area');
    const guardArea = document.getElementById('guard-area');

    // 1. 重置所有按鈕與區塊狀態
    endBtn.classList.add('hidden');
    voteBtn.classList.add('hidden');
    nightBtn.classList.add('hidden');
    abstainBtn.classList.add('hidden');
    
    if (witchArea) witchArea.classList.add('hidden');
    if (guardArea) guardArea.classList.add('hidden');

    if (data.phase === 'night') {
        title.innerText = "🌙 天黑請閉眼";
        title.style.color = "#9c27b0";
        addLog("=== 進入夜晚 ===");
        
        if ((myRole === '女巫' || myRole === '守衛') && isAlive) {
            endBtn.classList.remove('hidden');
            endBtn.disabled = false;
            endBtn.innerText = "結束我的回合";
        }
        
        document.querySelectorAll('.player-btn').forEach(b => b.disabled = false);

        if (myRole === '女巫') {
            if (witchArea) witchArea.classList.remove('hidden');
            document.getElementById('victim-name').innerText = "等待狼人行動...";
            const saveBtn = document.getElementById('btn-save');
            saveBtn.disabled = true;
            if (data.potions && !data.potions.heal) {
                saveBtn.innerText = "解藥已用完";
            } else {
                saveBtn.innerText = "使用解藥";
            }
        }

        if (myRole === '守衛') {
            if (guardArea) guardArea.classList.remove('hidden');
            document.getElementById('guard-target').innerText = "尚未選擇";
        }

    } else if (data.phase === 'day_speak') {
        title.innerText = "☀️ 天亮了";
        title.style.color = "#ffeb3b";
        
        if (lastPhase === 'night') {
            if (data.dead && data.dead.length > 0) {
                addLog(`昨晚死亡：${data.dead.join(', ')}`);
            } else {
                addLog("昨晚是平安夜！");
            }
        }

        if (isAlive) voteBtn.classList.remove('hidden');
        document.querySelectorAll('.player-btn').forEach(b => b.disabled = true);

    } else if (data.phase === 'day_vote') {
        title.innerText = "🗳️ 投票階段";
        title.style.color = "#2196f3";
        addLog("請點擊按鈕投票...");
        document.querySelectorAll('.player-btn').forEach(b => b.disabled = false);

        if (isAlive) {
            abstainBtn.classList.remove('hidden');
            abstainBtn.disabled = false;
        }

    } else if (data.phase === 'shoot') {
        title.innerText = "🔫 狼王/獵人 發動技能中...";
        title.style.color = "red";
        addLog(`【注意】${data.shooter} 死亡，正在選擇帶走對象...`);
        document.querySelectorAll('.player-btn').forEach(b => b.disabled = true);
    }
});

socket.on('your_turn_to_shoot', () => {
    alert("你死亡了！請選擇一名玩家帶走。");
    addLog("請點擊一名玩家開槍！");
    document.querySelectorAll('.player-btn').forEach(b => b.disabled = false);
});

socket.on('vote_result_final', () => {
    document.getElementById('btn-go-night').classList.remove('hidden');
});

socket.on('vote_pk', (data) => {
    const amIPKTarget = data.targets.includes(myName);

    if (amIPKTarget) {
        alert(`⚖️ ${data.msg}\n\n【注意】你是 PK 對象，本輪無法投票！`);
        addLog(`[系統] 平票 PK：你無法投票。`);
        document.querySelectorAll('.player-btn').forEach(b => {
            b.disabled = true;
            b.style.border = "none";
        });
        const abstainBtn = document.getElementById('btn-abstain');
        if (abstainBtn) abstainBtn.disabled = true;
    } else {
        alert(`⚖️ ${data.msg}\n\n請在平票者之間重新投票！`);
        addLog(`[系統] ${data.msg}`);

        document.querySelectorAll('.player-btn').forEach(b => {
            let btnText = b.innerText;
            let isTarget = false;
            data.targets.forEach(targetName => {
                if (btnText.includes(targetName)) {
                    isTarget = true;
                }
            });

            if (isTarget) {
                b.disabled = false;
                b.style.border = "2px solid red"; 
            } else {
                b.disabled = true;
                b.style.border = "none";
            }
        });
        const abstainBtn = document.getElementById('btn-abstain');
        if (abstainBtn) abstainBtn.disabled = false;
    }
});

socket.on('vote_result', (data) => {
    addLog(`投票結果：${data.victim}`);
    document.querySelectorAll('.player-btn').forEach(b => b.disabled = true);
    document.getElementById('btn-abstain').disabled = true;
});

socket.on('wolf_notification', (data) => { if(myRole.includes('狼') && isAlive) addLog(`[狼隊] ${data.msg}`); });
socket.on('witch_vision', (data) => {
    if (!isAlive) return;
    document.getElementById('victim-name').innerText = data.victim;
    const btn = document.getElementById('btn-save');
    if (btn.innerText !== "解藥已用完") {
        btn.disabled = false;
    }
    addLog(`[感應] 狼人結束行動，目標是 ${data.victim}。請決定是否使用解藥，然後按結束回合。`, "witch-vision");
});

socket.on('force_confirm', (data) => {
    addLog(data.msg);
    document.querySelectorAll('.player-btn').forEach(b => b.disabled = true);
    const endBtn = document.getElementById('btn-end-turn');
    if (endBtn) endBtn.disabled = true;
});

socket.on('seer_result', (data) => { alert(`查驗結果: ${data.target} 是 ${data.identity}`); });
socket.on('action_result', (data) => { addLog(`[系統] ${data.msg}`); });

// 處理玩家點擊頭像 (核心邏輯)
function handlePlayerClick(targetName) {
    console.log(`點擊: ${targetName}, 階段: ${currentPhase}, 存活: ${isAlive}`);

    // 1. 死人檢查
    if (!isAlive) {
        alert("👻 你已經死亡，無法進行任何操作！");
        return;
    }

    // 2. 投票階段 (Day Vote)
    if (currentPhase === 'day_vote') {
        if (confirm(`🗳️ 確定要投給 【${targetName}】 嗎？\n(投出後無法更改)`)) {
            socket.emit('day_vote', {room: myRoom, target: targetName});
            document.querySelectorAll('.player-btn').forEach(btn => {
                btn.disabled = true;
                btn.style.opacity = "0.6";
                btn.style.cursor = "not-allowed";
            });
            addLog(`[系統] 你已投票給 ${targetName}。`);
        }
        return;
    }

    // 3. 開槍階段 (Shoot)
    if (currentPhase === 'shoot') {
        if (confirm(`🔫 確定要開槍帶走 【${targetName}】 嗎？`)) {
            socket.emit('shoot_action', {room: myRoom, target: targetName});
        }
        return;
    }

    // 4. 發言階段 (Day Speak)
    if (currentPhase === 'day_speak') {
        alert("🗣️ 現在是發言討論時間，請等待投票開始！");
        return;
    }

    // 5. 夜間技能階段 (Night)
    if (currentPhase === 'night') {
        if (selectedAction) {
            // 女巫邏輯
            if (selectedAction === 'save') {
                if (confirm(`🧪 確定要對 ${targetName} 使用解藥嗎？`)) {
                    socket.emit('night_action', {room: myRoom, type: 'witch_save', target: targetName});
                    selectedAction = null;
                    resetActionButtons();
                }
            } else if (selectedAction === 'poison') {
                if (confirm(`☠️ 確定要毒死 ${targetName} 嗎？`)) {
                    socket.emit('night_action', {room: myRoom, type: 'witch_poison', target: targetName});
                    selectedAction = null;
                    resetActionButtons();
                }
            }
        } 
        else if (myRole === '預言家') {
            socket.emit('night_action', {room: myRoom, type: 'seer_check', target: targetName});
        }
        else if (myRole === '狼人' || myRole === '狼王') {
            socket.emit('night_action', {room: myRoom, type: 'wolf_vote', target: targetName});
        }
        else if (myRole === '守衛') {
            socket.emit('night_action', {room: myRoom, type: 'guard_protect', target: targetName});
        }
        else {
            addLog("[系統] 天黑請閉眼，現在不是你的行動時間。");
        }
        return;
    }

    console.log("未定義的點擊行為");
}

function addLog(msg, className='') { 
    const log = document.getElementById('log-area'); 
    log.innerHTML += `<div class="${className}">${msg}</div>`; 
    log.scrollTop = log.scrollHeight; 
}

// 斷線自動重連機制
socket.on('disconnect', () => {
    console.log("斷線了...");
    addLog("[系統] 連線不穩，正在嘗試重連...");
    document.querySelectorAll('button').forEach(btn => btn.disabled = true);
});

socket.on('connect', () => {
    console.log("連線成功！");
    addLog("[系統] 連線已恢復！");
    if (myName && myRoom) {
        socket.emit('join', {username: myName, room: myRoom});
    }
});

// 監聽視窗切換
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        if (!socket.connected) {
            console.log("切回視窗，嘗試重連...");
            socket.connect();
        }
    }
});

// 網頁載入時自動重連
window.onload = function() {
    const savedName = localStorage.getItem('ww_username');
    const savedRoom = localStorage.getItem('ww_room');

    if (savedName && savedRoom) {
        console.log("偵測到舊紀錄，自動填入...");
        document.getElementById('username').value = savedName;
        document.getElementById('room').value = savedRoom;
    }
};