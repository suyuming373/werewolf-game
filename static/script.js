const socket = io();
let myRoom = "";
let myName = "";
let myRole = "";
let isAlive = true; 
let currentPhase = "setup"; 

// ... (joinGame, startGame, confirmTurn, startVoting, goToNight, usePotion 維持不變) ...
function joinGame() {
    const username = document.getElementById('username').value;
    const room = document.getElementById('room').value;

    if (username && room) {
        myName = username;
        myRoom = room;
        
        // [新增] 把名字和房號存在瀏覽器裡
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
function usePotion(t) { 
    if (!isAlive) return;
    socket.emit('night_action', {room: myRoom, type: 'witch_save'}); 
    document.getElementById('btn-save').disabled = true; 
    document.getElementById('btn-save').innerText = "已使用解藥";
}

// [新增] 棄票函式
function voteAbstain() {
    if (!isAlive) return;
    // 送出目標為 "棄票"
    socket.emit('day_vote', {room: myRoom, target: '棄票'});
    addLog("你選擇了棄票");
    
    // 鎖定所有按鈕
    document.querySelectorAll('.player-btn').forEach(b => b.disabled = true);
    document.getElementById('btn-abstain').disabled = true;
}

// [新增] 踢人函式
function kickPlayer(targetName) {
    if (confirm(`確定要踢出 ${targetName} 嗎？`)) {
        socket.emit('kick_player', {room: myRoom, target_name: targetName});
    }
}

// [新增] 發送重置請求
function resetGame() {
    if (confirm("確定要強制重置房間嗎？\n(所有遊戲進度將會遺失)")) {
        socket.emit('reset_game', {room: myRoom});
    }
}

// ---------------- 監聽 ----------------

// [新增] 狼隊友詳細名單
socket.on('wolf_teammates', (data) => {
    let msg = "🐺 你的狼隊友：\n";
    if (data.teammates.length === 0) {
        msg += "(無，你是孤狼)";
    } else {
        data.teammates.forEach(t => {
            msg += `- ${t.name} [${t.role}]\n`;
        });
    }
    addLog(msg, "wolf-msg"); // 加個 class 方便樣式控制
});

// [新增] 被踢出的處理
socket.on('kicked', (data) => {
    alert(data.msg);
    location.reload(); // 強制重整，回到登入頁
});

// [新增] 監聽開始失敗 (在大廳彈窗)
socket.on('start_failed', (data) => {
    alert(data.msg);
});

// [新增] 監聽重置事件
socket.on('game_reset', (data) => {
    alert(data.msg);
    location.reload(); // 全員重整，回到登入畫面/大廳
});

socket.on('update_players', (data) => {
    // 找出我是誰，更新存活狀態
    const me = data.players.find(p => p.name === myName);
    if (me) {
        isAlive = me.alive; // [重要] 同步伺服器的存活狀態
        
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

        // [新增] 踢人按鈕 (只有房主看得到，且不能踢自己，且必須在準備階段)
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

    const gameList = document.getElementById('game-players');
    gameList.innerHTML = "";
    data.players.forEach(p => {
        // ... (遊戲中頭像邏輯維持不變) ...
        if (p.alive) {
            let btn = document.createElement('button');
            btn.innerHTML = `<span class="number-badge">${p.number}</span> ${p.name}`;
            btn.className = "player-btn";
            btn.onclick = () => handlePlayerClick(p.name);
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

socket.on('public_vote_log', (data) => {
    addLog(`🗳️ ${data.voter} 投給了 ${data.target}`);
});

socket.on('host_update', (data) => {
    if (data.is_host) {
        document.getElementById('host-settings').classList.remove('hidden');
        document.getElementById('guest-waiting-msg').classList.add('hidden');
    } else {
        document.getElementById('host-settings').classList.add('hidden');
        document.getElementById('guest-waiting-msg').classList.remove('hidden');
    }
});

socket.on('update_players', (data) => {
    const me = data.players.find(p => p.name === myName);
    if (me) {
        isAlive = me.alive;
        if (!isAlive) {
            document.getElementById('my-role-info').innerText += " (已死亡)";
            document.getElementById('my-role-info').style.color = "gray";
        }
    }

    const list = document.getElementById('player-list');
    list.innerHTML = "";
    data.players.forEach(p => {
        let li = document.createElement('li');
        let text = p.number > 0 ? `[${p.number}] ${p.name}` : p.name;
        if (p.is_host) text += " 👑";
        li.innerText = text;
        list.appendChild(li);
    });

    const gameList = document.getElementById('game-players');
    gameList.innerHTML = "";
    data.players.forEach(p => {
        if (p.alive) {
            let btn = document.createElement('button');
            btn.innerHTML = `<span class="number-badge">${p.number}</span> ${p.name}`;
            btn.className = "player-btn";
            btn.onclick = () => handlePlayerClick(p.name);
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
    // [新增] 先把舊的階段存起來
    const lastPhase = currentPhase;

    currentPhase = data.phase;
    const title = document.getElementById('phase-title');
    const endBtn = document.getElementById('btn-end-turn');
    const voteBtn = document.getElementById('btn-start-vote');
    const nightBtn = document.getElementById('btn-go-night');
    const abstainBtn = document.getElementById('btn-abstain'); // [新增] 抓取按鈕
    const witchArea = document.getElementById('witch-area'); // 先抓出來
    const guardArea = document.getElementById('guard-area');

    // 1. 重置所有按鈕與區塊狀態
    endBtn.classList.add('hidden');
    voteBtn.classList.add('hidden');
    nightBtn.classList.add('hidden');
    abstainBtn.classList.add('hidden'); // [新增] 預設隱藏
    
    // [重要] 預設先隱藏女巫區，等一下判斷是女巫再打開
    // 這樣可以確保白天轉夜晚時，狀態是被重置過的
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

        // 女巫邏輯
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

        // [新增] 守衛邏輯
        if (myRole === '守衛') {
            if (guardArea) guardArea.classList.remove('hidden');
            document.getElementById('guard-target').innerText = "尚未選擇";
        }

    } else if (data.phase === 'day_speak') {
        title.innerText = "☀️ 天亮了";
        title.style.color = "#ffeb3b";
        // [關鍵修正] 只有「上一階段是夜晚」才播報死亡資訊
        // 這樣開完槍回來就不會亂報平安夜了
        if (lastPhase === 'night') {
            if (data.dead && data.dead.length > 0) {
                addLog(`昨晚死亡：${data.dead.join(', ')}`);
            } else {
                addLog("昨晚是平安夜！");
            }
        }

        if (isAlive) voteBtn.classList.remove('hidden');
        
        // 鎖住頭像，避免誤觸
        document.querySelectorAll('.player-btn').forEach(b => b.disabled = true);

    } else if (data.phase === 'day_vote') {
        title.innerText = "🗳️ 投票階段";
        title.style.color = "#2196f3";
        addLog("請點擊按鈕投票...");
        // 解鎖頭像供投票
        document.querySelectorAll('.player-btn').forEach(b => b.disabled = false);

        if (isAlive) {
            abstainBtn.classList.remove('hidden');
            abstainBtn.disabled = false; // 確保按鈕是可按的
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

// [新增] 監聽 PK (平票) 事件
socket.on('vote_pk', (data) => {
    // 1. 先判斷我自己是不是平票對象 (PK台上的人)
    const amIPKTarget = data.targets.includes(myName);

    if (amIPKTarget) {
        // --- 情況 A：我是當事人 ---
        alert(`⚖️ ${data.msg}\n\n【注意】你是 PK 對象，本輪無法投票！`);
        addLog(`[系統] 平票 PK：你無法投票。`);
        
        // 鎖定所有按鈕
        document.querySelectorAll('.player-btn').forEach(b => {
            b.disabled = true;
            b.style.border = "none";
        });
        
        // 鎖定棄票鈕
        const abstainBtn = document.getElementById('btn-abstain');
        if (abstainBtn) abstainBtn.disabled = true;

    } else {
        // --- 情況 B：我是路人 (台下投票) ---
        alert(`⚖️ ${data.msg}\n\n請在平票者之間重新投票！`);
        addLog(`[系統] ${data.msg}`);

        // 處理按鈕狀態
        document.querySelectorAll('.player-btn').forEach(b => {
            let btnText = b.innerText;
            let isTarget = false;
            
            // 檢查這個按鈕是不是 PK 對象
            data.targets.forEach(targetName => {
                if (btnText.includes(targetName)) {
                    isTarget = true;
                }
            });

            if (isTarget) {
                // 是 PK 對象 -> 可以投 -> 解鎖 + 紅框
                b.disabled = false;
                b.style.border = "2px solid red"; 
            } else {
                // 不是 PK 對象 -> 不能投 -> 鎖定
                b.disabled = true;
                b.style.border = "none";
            }
        });

        // 棄票按鈕永遠保持解鎖 (路人可以棄票)
        const abstainBtn = document.getElementById('btn-abstain');
        if (abstainBtn) abstainBtn.disabled = false;
    }
});

socket.on('vote_result', (data) => {
    // [修改] 直接顯示後端傳來的訊息，不要再自己加字
    addLog(`投票結果：${data.victim}`);
    document.querySelectorAll('.player-btn').forEach(b => b.disabled = true);
    document.getElementById('btn-abstain').disabled = true; // 確保棄票鈕也被鎖
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

    // 1. 死人檢查：如果你死了，點什麼都沒用
    if (!isAlive) {
        alert("👻 你已經死亡，無法進行任何操作！");
        return;
    }

    // 2. 投票階段 (Day Vote) - 最優先處理
    if (currentPhase === 'day_vote') {
        if (confirm(`🗳️ 確定要投給 【${targetName}】 嗎？\n(投出後無法更改)`)) {
            socket.emit('day_vote', {room: myRoom, target: targetName});
            
            // 視覺鎖定：讓按鈕變灰，防止連點
            document.querySelectorAll('.player-btn').forEach(btn => {
                btn.disabled = true;
                btn.style.opacity = "0.6";
                btn.style.cursor = "not-allowed";
            });
            
            addLog(`[系統] 你已投票給 ${targetName}。`);
        }
        return; // 結束函式，不繼續往下跑
    }

    // 3. 開槍階段 (Shoot)
    if (currentPhase === 'shoot') {
        if (confirm(`🔫 確定要開槍帶走 【${targetName}】 嗎？`)) {
            socket.emit('shoot_action', {room: myRoom, target: targetName});
        }
        return; // 結束函式
    }

    // 4. 發言階段 (Day Speak) - 禁止操作
    if (currentPhase === 'day_speak') {
        alert("🗣️ 現在是發言討論時間，請等待投票開始！");
        return; // 結束函式
    }

    // 5. 夜間技能階段 (Night)
    if (currentPhase === 'night') {
        // 檢查有沒有選中技能 (例如女巫選藥水)
        if (selectedAction) {
            // 女巫邏輯
            if (selectedAction === 'heal') {
                if (confirm(`🧪 確定要對 ${targetName} 使用解藥嗎？`)) {
                    socket.emit('witch_action', {room: myRoom, type: 'save', target: targetName});
                    selectedAction = null;
                    resetActionButtons();
                }
            } else if (selectedAction === 'poison') {
                if (confirm(`☠️ 確定要毒死 ${targetName} 嗎？`)) {
                    socket.emit('witch_action', {room: myRoom, type: 'poison', target: targetName});
                    selectedAction = null;
                    resetActionButtons();
                }
            }
        } 
        // 預言家邏輯 (直接點頭像)
        else if (myRole === '預言家') {
            socket.emit('seer_check', {room: myRoom, target: targetName});
        }
        // 狼人邏輯 (直接點頭像)
        else if (myRole === '狼人' || myRole === '狼王') {
            socket.emit('wolf_vote', {room: myRoom, target: targetName});
        }
        // 守衛邏輯 (直接點頭像)
        else if (myRole === '守衛') {
            socket.emit('guard_action', {room: myRoom, target: targetName});
        }
        else {
            // 如果是平民或獵人晚上亂點
            addLog("[系統] 天黑請閉眼，現在不是你的行動時間。");
        }
        return;
    }

    // 6. 其他情況 (Setup 等)
    console.log("未定義的點擊行為");
}

function addLog(msg, className='') { 
    const log = document.getElementById('log-area'); 
    log.innerHTML += `<div class="${className}">${msg}</div>`; 
    log.scrollTop = log.scrollHeight; 
}

// [新增] 斷線自動重連機制
socket.on('disconnect', () => {
    console.log("斷線了...");
    addLog("[系統] 連線不穩，正在嘗試重連...");
    // 讓按鈕變灰，避免誤觸
    document.querySelectorAll('button').forEach(btn => btn.disabled = true);
});

socket.on('connect', () => {
    console.log("連線成功！");
    addLog("[系統] 連線已恢復！");
    // 如果是斷線後重連，可能需要重新發送加入房間的請求
    if (myName && myRoom) {
        socket.emit('join', {username: myName, room: myRoom});
    }
});

// [新增] 監聽視窗切換 (當玩家切回來時)
// ... (上面監聽 visibilitychange 的部分維持原樣)
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        if (!socket.connected) {
            console.log("切回視窗，嘗試重連...");
            socket.connect();
        }
    }
});

// [補回] 網頁載入時，檢查有沒有舊的登入資料 (F5 自動重連)
window.onload = function() {
    const savedName = localStorage.getItem('ww_username');
    const savedRoom = localStorage.getItem('ww_room');

    if (savedName && savedRoom) {
        console.log("偵測到舊紀錄，自動填入...");
        document.getElementById('username').value = savedName;
        document.getElementById('room').value = savedRoom;
        
        // 如果想要自動幫他按加入，可以把下面這行註解打開：
        // joinGame(); 
    }
};