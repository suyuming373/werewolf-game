const socket = io();
let myRoom = "";
let myName = "";
let myRole = "";
let isAlive = true; 
let currentPhase = "setup"; 
let amIHost = false; 

// ================== 自製彈窗與提示工具 ==================

// 顯示確認視窗 (取代 confirm)
function showConfirm(msg, callback) {
    const modal = document.getElementById('custom-modal');
    // 防呆：如果 HTML 裡還沒加 modal 結構，先 fallback 回原生 confirm
    if (!modal) {
        if (confirm(msg)) {
            if (callback) callback();
        }
        return;
    }

    document.getElementById('modal-message').innerText = msg;
    modal.classList.remove('hidden');

    const confirmBtn = document.getElementById('btn-modal-confirm');
    const cancelBtn = document.getElementById('btn-modal-cancel');

    // 複製按鈕以移除舊的 Event Listener
    let newConfirm = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);
    
    let newCancel = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);

    // 綁定確認事件
    newConfirm.onclick = () => {
        closeModal();
        if (callback) callback();
    };

    // 綁定取消事件
    newCancel.onclick = () => {
        closeModal();
    };
    
    // 如果沒有 callback，代表只是純訊息提示 (類似 alert)
    if (!callback) {
        newCancel.classList.add('hidden'); // 隱藏取消鈕
        newConfirm.innerText = "知道了";
    } else {
        newCancel.classList.remove('hidden'); // 顯示取消鈕
        newConfirm.innerText = "確定";
    }
}

function endTurn() {
    // 鎖定按鈕避免重複點擊
    const btn = document.getElementById('btn-end-turn');
    if (btn) {
        btn.disabled = true;
        btn.innerText = "已確認，等待天亮...";
    }
    
    // 鎖定女巫的其他按鈕 (既然都要結束了，就不能再用藥)
    const saveBtn = document.getElementById('btn-save');
    const poisonBtn = document.getElementById('btn-poison');
    if (saveBtn) saveBtn.disabled = true;
    if (poisonBtn) poisonBtn.disabled = true;

    // 發送確認訊號給後端
    // 後端收到 confirm_turn 會把你加入 ready_players
    socket.emit('confirm_turn', { room: myRoom });
}

function closeModal() {
    const modal = document.getElementById('custom-modal');
    if (modal) modal.classList.add('hidden');
}

// 顯示 Toast 提示 (取代 alert)
function showToast(msg) {
    const toast = document.getElementById('toast-message');
    if (!toast) {
        alert(msg); // Fallback
        return;
    }
    
    toast.innerText = msg;
    toast.classList.remove('hidden');
    toast.style.opacity = 1;
    
    // 3秒後自動消失
    setTimeout(() => {
        toast.style.opacity = 0;
        setTimeout(() => { toast.classList.add('hidden'); }, 300);
    }, 3000);
}

// ================== 按鈕功能區 ==================

function joinGame() {
    const usernameInput = document.getElementById('username').value;
    const roomInput = document.getElementById('room').value;

    // [修復] 去除前後空白，防止手機輸入法導致的「幽靈房間」
    const username = usernameInput ? usernameInput.trim() : "";
    const room = roomInput ? roomInput.trim() : "";

    if (username && room) {
        myName = username;
        myRoom = room;
        
        // 更新 UI 顯示正確的去空白文字
        document.getElementById('username').value = username;
        document.getElementById('room').value = room;
        
        // 存入快取
        localStorage.setItem('ww_username', username);
        localStorage.setItem('ww_room', room);

        socket.emit('join', {username: username, room: room});
    } else {
        showToast("⚠️ 請輸入暱稱和房號！(不能只有空白)");
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
    
    const btn = document.getElementById('btn-end-turn');
    if (btn) {
        btn.disabled = true; 
        btn.innerText = "已確認 / 等待其他玩家..."; 
    }
}

function startVoting() { socket.emit('start_voting', {room: myRoom}); }
function goToNight() { socket.emit('go_to_night', {room: myRoom}); }

// ================== 女巫藥水邏輯 ==================

let selectedAction = null; // 記錄目前選了什麼藥水

function usePotion(type) {
    if (!isAlive) return;

    if (type === 'save') {
        // --- 解藥邏輯 ---
        const victimElem = document.getElementById('victim-name');
        const victim = victimElem ? victimElem.innerText : "";
        
        if (!victim || victim === "(等待狼人行動...)" || victim === "未知") {
            showToast("⚠️ 還不知道狼人殺了誰，無法使用解藥！");
            return;
        }

        showConfirm(`🧪 確定要對 ${victim} 使用解藥嗎？`, () => {
            socket.emit('night_action', {room: myRoom, type: 'witch_save', target: victim});
            
            // [新增] 鎖定解藥按鈕
            const saveBtn = document.getElementById('btn-save');
            if (saveBtn) {
                saveBtn.disabled = true;
                saveBtn.innerText = "已使用解藥";
            }
            
            // [新增] 也要鎖定毒藥按鈕 (一晚限一瓶)
            const poisonBtn = document.getElementById('btn-poison');
            if (poisonBtn) {
                poisonBtn.disabled = true;
                poisonBtn.innerText = "無法使用 (限一瓶)";
                poisonBtn.style.background = "#555";
            }
            
            showToast("已使用解藥，回合結束");
            lockWitchUI(); // [關鍵] 立刻鎖定介面
        });

    } else if (type === 'poison') {
        // --- 毒藥邏輯 ---
        selectedAction = 'poison'; 
        
        showToast("☠️ 請點擊下方一名「玩家頭像」進行下毒！");
        
        const pBtn = document.getElementById('btn-poison');
        if (pBtn) {
            pBtn.innerText = "請選擇目標...";
            pBtn.style.border = "2px solid white";
        }
        
        document.querySelectorAll('.player-btn').forEach(btn => {
            btn.disabled = false;
            btn.style.cursor = "pointer";
            btn.style.opacity = "1";
        });
    }
}

// 女巫行動後鎖定介面 (防止重複操作)
function lockWitchUI() {
    // 鎖定所有按鈕
    document.getElementById('btn-save').disabled = true;
    document.getElementById('btn-poison').disabled = true;
    
    // 鎖定結束回合按鈕 (如果有的話)
    const endBtn = document.getElementById('btn-end-turn');
    if (endBtn) {
        endBtn.disabled = true;
        endBtn.innerText = "已行動 / 等待天亮...";
    }

    // 恢復頭像狀態
    document.querySelectorAll('.player-btn').forEach(btn => {
        btn.style.border = "none";
        btn.style.opacity = "0.5"; // 變暗表示不能點了
        btn.disabled = true;
    });
    
    selectedAction = null;
}

// [新增] 鎖定守衛介面
function lockGuardUI() {
    // 鎖定所有頭像
    document.querySelectorAll('.player-btn').forEach(btn => {
        btn.disabled = true;
        btn.style.opacity = "0.6";
        btn.style.border = "none";
    });

    // 鎖定空守按鈕 (如果有的話)
    // 這裡我們假設空守按鈕的 onclick 是 skipGuard()，我們可以透過 querySelector 抓它
    // 或者你可以給空守按鈕一個 id="btn-skip-guard" 會更準確，這裡先用通用的方式鎖
    const buttons = document.getElementsByTagName('button');
    for (let btn of buttons) {
        if (btn.innerText.includes("空守")) {
            btn.disabled = true;
            btn.innerText = "已選擇空守";
        }
    }

    // 鎖定結束回合按鈕
    const endBtn = document.getElementById('btn-end-turn');
    if (endBtn) {
        endBtn.disabled = true;
        endBtn.innerText = "已行動 / 等待天亮...";
    }
}

// [新增] 守衛空守
function skipGuard() {
    if (!isAlive) return;
    
    showConfirm("確定今晚【不守護】任何人嗎？", () => {
        socket.emit('night_action', {room: myRoom, type: 'guard_skip'});
        
        // [新增] 鎖定介面
        lockGuardUI();
        showToast("已選擇空守，回合結束");
    });
}

// ================== 其他操作功能 ==================

function voteAbstain() {
    if (!isAlive) return;
    showConfirm("確定要棄票嗎？", () => {
        socket.emit('day_vote', {room: myRoom, target: '棄票'});
        addLog("你選擇了棄票");
        
        // 鎖定所有按鈕
        document.querySelectorAll('.player-btn').forEach(b => b.disabled = true);
        const abstainBtn = document.getElementById('btn-abstain');
        if (abstainBtn) abstainBtn.disabled = true;
    });
}

function kickPlayer(targetName) {
    showConfirm(`確定要踢出 ${targetName} 嗎？`, () => {
        socket.emit('kick_player', {room: myRoom, target_name: targetName});
    });
}

function resetGame() {
    showConfirm("確定要強制重置房間嗎？\n(所有遊戲進度將會遺失)", () => {
        socket.emit('reset_game', {room: myRoom});
    });
}

function logout() {
    showConfirm("確定要登出並切換帳號嗎？", () => {
        // 1. 清除瀏覽器記憶
        localStorage.removeItem('ww_username');
        localStorage.removeItem('ww_room');
        
        // 2. 重新整理網頁
        location.reload();
    });
}

// 2. 發送指令的函式
function adminAction(action) {
    if (!amIHost) return;
    
    // 加個確認防止手殘
    if (action.includes('force') && !confirm("確定要強制跳過目前階段嗎？\n(這可能會導致部分技能沒結算)")) {
        return;
    }

    socket.emit('admin_action', { room: myRoom, action: action });
}

// ================== Socket 監聽與邏輯區 ==================

socket.on('join_success', (data) => {
    console.log("加入成功！房主身分:", data.is_host);
    amIHost = data.is_host;
    
    // 切換到大廳畫面
    document.getElementById('login-view').classList.add('hidden');
    document.getElementById('lobby-view').classList.remove('hidden');

    // 根據身分顯示不同介面
    const hostSettings = document.getElementById('host-settings');
    const guestMsg = document.getElementById('guest-waiting-msg');

    if (amIHost) {
        if (hostSettings) hostSettings.classList.remove('hidden');
        if (guestMsg) guestMsg.classList.add('hidden');
    } else {
        if (hostSettings) hostSettings.classList.add('hidden');
        if (guestMsg) guestMsg.classList.remove('hidden');
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

// [修復] 使用 showConfirm 取代 alert
socket.on('kicked', (data) => {
    showConfirm(data.msg, () => {
        location.reload(); 
    });
});

socket.on('start_failed', (data) => {
    showConfirm(data.msg);
});

socket.on('game_reset', (data) => {
    showConfirm(data.msg, () => {
        location.reload(); 
    });
});

// [新增] 離開房間 (個人退出)
function leaveRoom() {
    showConfirm("確定要離開房間嗎？\n(這會清除登入紀錄並回到首頁)", () => {
        // 1. 清除瀏覽器記憶 (這樣重整後才不會自動登入)
        localStorage.removeItem('ww_username');
        localStorage.removeItem('ww_room');
        
        // 2. 重新整理網頁 -> 觸發 socket disconnect -> 回到登入頁
        location.reload();
    });
}

socket.on('public_vote_log', (data) => {
    addLog(`🗳️ ${data.voter} 投給了 ${data.target}`);
});

socket.on('update_players', (data) => {
    // 找出我是誰，更新存活狀態
    const me = data.players.find(p => p.name === myName);
    if (me) {
        isAlive = me.alive;
        amIHost = me.is_host; 
        
        if (!isAlive) {
            const roleInfo = document.getElementById('my-role-info');
            if (roleInfo && !roleInfo.innerText.includes("(已死亡)")) {
                roleInfo.innerText += " (已死亡)";
                roleInfo.style.color = "gray";
            }
            // 鎖定按鈕
            document.querySelectorAll('.player-btn').forEach(b => b.disabled = true);
        }
    }

    // 更新大廳列表
    const list = document.getElementById('player-list');
    if (list) {
        list.innerHTML = "";
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
    }

    // 更新房主設定顯示狀態
    const hostSettings = document.getElementById('host-settings');
    const guestMsg = document.getElementById('guest-waiting-msg');
    
    if (currentPhase === 'setup') {
        if (amIHost) {
            if(hostSettings) hostSettings.classList.remove('hidden');
            if(guestMsg) guestMsg.classList.add('hidden');
        } else {
            if(hostSettings) hostSettings.classList.add('hidden');
            if(guestMsg) guestMsg.classList.remove('hidden');
        }
    }

    // 更新遊戲中玩家按鈕
    const gameList = document.getElementById('game-players');
    if (gameList) {
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
    }

    // [新增] 遊戲中顯示房主控制區
    const ingameControls = document.getElementById('ingame-host-controls');
    if (ingameControls) {
        // 如果我是房主，而且遊戲正在進行中 (不是 setup)，就顯示按鈕
        if (amIHost && currentPhase !== 'setup') {
            ingameControls.classList.remove('hidden');
        } else {
            ingameControls.classList.add('hidden');
        }
    }

    // [新增] 如果我是房主，顯示救難包
    const adminPanel = document.getElementById('admin-panel');
    if (amIHost && adminPanel) {
        adminPanel.classList.remove('hidden');
    } else if (adminPanel) {
        adminPanel.classList.add('hidden');
    }

});

socket.on('game_over', (data) => {
    let msg = `🏆 遊戲結束！\n\n獲勝陣營：${data.winner}！！！\n\n=== 角色揭曉 ===\n`;
    for (const [name, role] of Object.entries(data.roles)) {
        msg += `${name}: ${role}\n`;
    }
    showConfirm(msg, () => {
        location.reload(); 
    });
});

socket.on('game_info', (data) => {
    myRole = data.role;
    isAlive = true; 
    document.getElementById('lobby-view').classList.add('hidden');
    document.getElementById('game-view').classList.remove('hidden');
    document.getElementById('my-role-info').innerText = `[${data.number}號] 身分：${myRole}`;
    
    const witchArea = document.getElementById('witch-area');
    if (myRole === '女巫' && witchArea) {
        witchArea.classList.remove('hidden');
        document.getElementById('victim-name').innerText = "等待狼人行動...";
        
        const saveBtn = document.getElementById('btn-save');
        if(saveBtn) saveBtn.disabled = true;
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
    if(endBtn) endBtn.classList.add('hidden');
    if(voteBtn) voteBtn.classList.add('hidden');
    if(nightBtn) nightBtn.classList.add('hidden');
    if(abstainBtn) abstainBtn.classList.add('hidden');
    
    if (witchArea) witchArea.classList.add('hidden');
    if (guardArea) guardArea.classList.add('hidden');

    if (data.phase === 'night') {
        title.innerText = "🌙 天黑請閉眼";
        title.style.color = "#9c27b0";
        addLog("=== 進入夜晚 ===");
        
        if (myRole === '女巫' && isAlive) {
            if(endBtn) {
                endBtn.classList.remove('hidden');
                endBtn.disabled = false;
                endBtn.innerText = "結束我的回合";
            }
        }
        
        document.querySelectorAll('.player-btn').forEach(b => b.disabled = false);

        if (myRole === '女巫') {
            if (witchArea) witchArea.classList.remove('hidden');
            const vName = document.getElementById('victim-name');
            if(vName) vName.innerText = "等待狼人行動...";
            
            // 1. 重置解藥按鈕 (這段原本就有)
            const saveBtn = document.getElementById('btn-save');
            if (saveBtn) {
                // 先假設可以按，除非...
                saveBtn.disabled = false; 
                if (data.potions && !data.potions.heal) {
                    saveBtn.disabled = true;
                    saveBtn.innerText = "解藥已用完";
                } else {
                    saveBtn.innerText = "使用解藥";
                    saveBtn.style.background = "#e040fb"; // 恢復顏色
                }
            }

            // 2. [新增] 重置毒藥按鈕 (這段是漏掉的！)
            // 每一晚開始時，都要檢查毒藥還在不在，如果在就要「解鎖」
            const poisonBtn = document.getElementById('btn-poison');
            if (poisonBtn) {
                // 先假設可以按
                poisonBtn.disabled = false; 
                
                if (data.potions && !data.potions.poison) {
                    // 真的用完了才鎖
                    poisonBtn.disabled = true;
                    poisonBtn.innerText = "毒藥已用完";
                    poisonBtn.style.border = "none";
                    poisonBtn.style.background = "#555";
                } else {
                    // 還沒用完 -> 恢復成可按狀態
                    poisonBtn.innerText = "使用毒藥";
                    poisonBtn.style.border = "none";
                    poisonBtn.style.background = "#9c27b0"; // 恢復原本紫色
                }
            }
        }

        if (myRole === '守衛') {
            if (guardArea) guardArea.classList.remove('hidden');
            const gTarget = document.getElementById('guard-target');
            if(gTarget) gTarget.innerText = "尚未選擇";
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

        if (isAlive && voteBtn) voteBtn.classList.remove('hidden');
        document.querySelectorAll('.player-btn').forEach(b => b.disabled = true);

    } else if (data.phase === 'day_vote') {
        title.innerText = "🗳️ 投票階段";
        title.style.color = "#2196f3";
        addLog("請點擊按鈕投票...");
        document.querySelectorAll('.player-btn').forEach(b => b.disabled = false);

        if (isAlive && abstainBtn) {
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
    showConfirm("你死亡了！\n請點擊一名玩家開槍帶走他。", () => {
        addLog("請點擊一名玩家開槍！");
        document.querySelectorAll('.player-btn').forEach(b => b.disabled = false);
    });
});

socket.on('vote_result_final', () => {
    const nightBtn = document.getElementById('btn-go-night');
    if(nightBtn) nightBtn.classList.remove('hidden');
});

socket.on('vote_pk', (data) => {
    const amIPKTarget = data.targets.includes(myName);

    if (amIPKTarget) {
        showConfirm(`⚖️ ${data.msg}\n\n【注意】你是 PK 對象，本輪無法投票！`);
        addLog(`[系統] 平票 PK：你無法投票。`);
        document.querySelectorAll('.player-btn').forEach(b => {
            b.disabled = true;
            b.style.border = "none";
        });
        const abstainBtn = document.getElementById('btn-abstain');
        if (abstainBtn) abstainBtn.disabled = true;
    } else {
        showConfirm(`⚖️ ${data.msg}\n\n請在平票者之間重新投票！`);
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
    const abstainBtn = document.getElementById('btn-abstain');
    if(abstainBtn) abstainBtn.disabled = true;
});

socket.on('wolf_notification', (data) => { 
    if(myRole.includes('狼') && isAlive) addLog(`[狼隊] ${data.msg}`); 
});

socket.on('witch_vision', (data) => {
    if (!isAlive) return;
    
    console.log("女巫感應收到:", data);
    document.getElementById('victim-name').innerText = data.victim;
    
    const btn = document.getElementById('btn-save');
    if (btn && btn.innerText !== "解藥已用完") {
        btn.disabled = false;
        btn.innerText = "使用解藥"; 
        btn.style.background = "#e040fb"; 
    }
    
    addLog(`[感應] 狼人目標是 ${data.victim}。`, "witch-vision");
});

socket.on('force_confirm', (data) => {
    addLog(data.msg);
    document.querySelectorAll('.player-btn').forEach(b => b.disabled = true);
    const endBtn = document.getElementById('btn-end-turn');
    if (endBtn) endBtn.disabled = true;
});

// [修改] 預言家查驗結果
socket.on('seer_result', (data) => { 
    // 1. 原本的彈窗 (保留，作為第一時間的提示)
    showConfirm(`🔮 查驗結果：\n\n${data.target} 是 【${data.identity}】`);

    // 2. [新增] 同步寫入文字紀錄區 (防止忘記)
    // 這裡我們加個 emoji 讓它顯眼一點
    addLog(`🔮 [查驗] ${data.target} 的身分是：${data.identity}`, "seer-msg");
});

socket.on('action_result', (data) => { addLog(`[系統] ${data.msg}`); });

// ================== 玩家點擊邏輯 (核心) ==================

function handlePlayerClick(targetName) {
    console.log(`點擊: ${targetName}, 階段: ${currentPhase}, 存活: ${isAlive}`);

    // 只有在「不是」開槍階段時，才阻擋死人操作
    if (!isAlive && currentPhase !== 'shoot'){
        showToast("👻 你已經死亡，無法操作！");
        return;
    }

    // 2. 投票階段
    // 在 handlePlayerClick 的 day_vote 區塊
    if (currentPhase === 'day_vote') {
        showConfirm(`🗳️ 確定要投給 【${targetName}】 嗎？\n(投出後無法更改)`, () => {
            socket.emit('day_vote', {room: myRoom, target: targetName});
            
            // 鎖定按鈕們...
            document.querySelectorAll('.player-btn').forEach(btn => {
                btn.disabled = true;
                btn.style.opacity = "0.6";
            });
            const abstainBtn = document.getElementById('btn-abstain');
            if (abstainBtn) {
                abstainBtn.disabled = true;
                abstainBtn.style.opacity = "0.6";
            }

            showToast(`已投票給 ${targetName}`);
            
            // [新增] 自己先顯示這行
            addLog(`[系統] 你投給了 ${targetName}`); 
        });
        return;
    }

    // 3. 開槍階段
    if (currentPhase === 'shoot') {
        showConfirm(`🔫 確定要開槍帶走 【${targetName}】 嗎？`, () => {
            socket.emit('shoot_action', {room: myRoom, target: targetName});
        });
        return;
    }

    // 4. 發言階段
    if (currentPhase === 'day_speak') {
        showToast("🗣️ 現在是發言討論時間，請等待投票開始！");
        return;
    }

    // 5. 夜間技能階段
    if (currentPhase === 'night') {
        
        // 如果按了「毒藥」按鈕
        if (selectedAction === 'poison') {
            showConfirm(`☠️ 確定要毒死 【${targetName}】 嗎？`, () => {
                socket.emit('night_action', {room: myRoom, type: 'witch_poison', target: targetName});
                
                // 重置狀態
                selectedAction = null;
                const pBtn = document.getElementById('btn-poison');
                if(pBtn) {
                    pBtn.disabled = true;
                    pBtn.innerText = "已使用毒藥";
                    pBtn.style.border = "none";
                }
                
                // [新增] 毒完人，解藥也要鎖起來 (一晚限一瓶)
                const saveBtn = document.getElementById('btn-save');
                if (saveBtn) {
                    saveBtn.disabled = true;
                    saveBtn.innerText = "無法使用 (限一瓶)";
                    saveBtn.style.background = "#555";
                }

                showToast(`已毒殺 ${targetName}，回合結束`);
                lockWitchUI(); // [關鍵] 立刻鎖定介面
            });
            return;
        }
        else if (myRole === '女巫') {
             showToast("⚠️ 請先點擊上方的「毒藥」按鈕，再選擇頭像！");
        }
        else if (myRole === '預言家') {
            // [修改] 預言家查驗前 -> 彈出確認窗 (猶豫時間)
            showConfirm(`🔮 確定要查驗 【${targetName}】 的身分嗎？`, () => {
                socket.emit('night_action', {room: myRoom, type: 'seer_check', target: targetName});
                
                // 按下確定後，鎖定介面 (防止重複點擊)
                document.querySelectorAll('.player-btn').forEach(btn => {
                    btn.disabled = true;
                    btn.style.opacity = "0.6";
                    btn.style.border = "none";
                });
                
                showToast("🔮 正在查驗中...");
            });
        }
        else if (myRole === '狼人' || myRole === '狼王') {
            socket.emit('night_action', {room: myRoom, type: 'wolf_vote', target: targetName});
        }
        else if (myRole === '守衛') {
            // [修改] 守衛點擊頭像 -> 彈出確認窗
            showConfirm(`🛡️ 確定要今晚守護 【${targetName}】 嗎？`, () => {
                socket.emit('night_action', {room: myRoom, type: 'guard_protect', target: targetName});
                
                // 按下確定後，鎖定介面並提示
                lockGuardUI();
                showToast(`已守護 ${targetName}，回合結束`);
            });
            // 如果按取消，什麼事都不會發生，守衛可以重新選人
        }
        else {
            showToast("天黑請閉眼，現在不是你的行動時間。");
        }
        return;
    }
}

function addLog(msg, className='') { 
    const log = document.getElementById('log-area'); 
    if(log) {
        log.innerHTML += `<div class="${className}">${msg}</div>`; 
        log.scrollTop = log.scrollHeight; 
    }
}

// ================== 系統連線處理 ==================

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

// [新增] 接收票型揭曉 (取代原本的即時廣播)
socket.on('vote_reveal', (data) => {
    addLog("=== 🗳️ 票型揭曉 ===");
    data.votes.forEach(v => {
        // 格式：小明 投給了 小華
        addLog(`${v.voter} 投給了 ${v.target}`);
    });
    addLog("==================");
});

// 原本的 public_vote_log 如果還在，可以刪掉，或者留著也沒關係(後端不會送了)

// 監聽視窗切換
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        if (!socket.connected) {
            console.log("切回視窗，嘗試重連...");
            socket.connect();
        }
    }
});

// [新增] 上帝登入成功
socket.on('admin_login_success', (data) => {
    // 1. 隱藏登入頁，顯示遊戲頁 (但我們會用上帝面板蓋住它)
    document.getElementById('login-view').classList.add('hidden');
    document.getElementById('game-view').classList.remove('hidden');
    
    // 2. 顯示上帝面板
    const godPanel = document.getElementById('god-mode-panel');
    godPanel.classList.remove('hidden');
    
    // 3. 設定權限 (讓你可以按那些按鈕)
    amIHost = true; // 這裡偷懶設為 true，因為我們前端 adminAction 有檢查 amIHost，後端也有檢查 admin_sid
    
    // 4. 更新身分列表
    updateGodRoleList(data.roles_reveal);
    document.getElementById('god-phase-display').innerText = data.current_phase;
    
    addLog("🕵️ 上帝模式啟動");
});

// [新增] 更新身分列表函式
function updateGodRoleList(roles) {
    const list = document.getElementById('god-roles-list');
    list.innerHTML = "";
    roles.forEach(info => {
        const li = document.createElement('li');
        li.innerText = info;
        li.style.borderBottom = "1px solid #444";
        li.style.padding = "5px";
        list.appendChild(li);
    });
}

// [修改] 監聽 socket 更新，讓身分列表保持最新
// 我們可以利用既有的 update_players，但因為你是上帝，不再玩家列表裡，
// 所以原本的 update_players 可能不會送給你 (看你的後端寫法)。
// 簡單起見，我們利用 adminAction('check_status') 回傳的結果來監控。

// 網頁載入時自動重連 (非手動登出時)
window.onload = function() {
    const savedName = localStorage.getItem('ww_username');
    const savedRoom = localStorage.getItem('ww_room');

    if (savedName && savedRoom) {
        console.log("偵測到舊紀錄，自動填入...");
        document.getElementById('username').value = savedName;
        document.getElementById('room').value = savedRoom;
        
        joinGame(); 
    }
};

// [新增] 上帝登入成功處理
socket.on('admin_login_success', (data) => {
    // 1. 隱藏登入介面
    document.getElementById('login-view').classList.add('hidden');
    
    // 2. 顯示上帝監控室 (蓋住原本的遊戲畫面)
    const godPanel = document.getElementById('god-mode-panel');
    godPanel.classList.remove('hidden');
    
    // 3. 填入玩家底牌
    updateGodUI(data.player_info);
    
    addLog("🕵️ 上帝模式已啟動");
});

// [新增] 用來更新上帝介面的玩家列表
function updateGodUI(infoList) {
    const list = document.getElementById('god-player-list');
    list.innerHTML = "";
    
    if (infoList && infoList.length > 0) {
        infoList.forEach(info => {
            const li = document.createElement('li');
            li.innerText = info;
            li.style.borderBottom = "1px solid #333";
            li.style.padding = "5px 0";
            
            // 根據關鍵字上色
            if (info.includes("狼")) li.style.color = "#ff5252"; // 紅色
            else if (info.includes("預言家")) li.style.color = "#e040fb"; // 紫色
            else if (info.includes("女巫")) li.style.color = "#ff4081"; // 粉色
            else if (info.includes("💀")) li.style.opacity = "0.5"; // 死人變暗
            else li.style.color = "#fff"; // 其他白色
            
            list.appendChild(li);
        });
    } else {
        list.innerHTML = "<li style='color: #888;'>目前無人加入</li>";
    }
}

// [修改] 發送指令 (現在只有上帝能用)
function adminAction(action) {
    // 增加確認框，怕上帝手滑
    if (action.includes('force') || action === 'reset_game') {
        if (!confirm("⚠️ 確定要執行此強制操作嗎？")) return;
    }
    socket.emit('admin_action', { room: myRoom, action: action });
}

// [小技巧] 利用 check_status 的回傳結果來刷新列表
// 因為 check_status 會回傳 msg，我們可以稍微修改後端讓它回傳最新列表，
// 但為了不改動太多，我們這裡暫時手動按「查兇手」時，順便在 Console 看結果就好。
// 或是你可以依賴 socket.on('update_players')，因為上帝也在房間裡，會收到 update_players。
socket.on('update_players', (data) => {
    // 如果上帝面板是開啟的，我們雖然沒有 role 資訊 (普通 update_players 不含身分)，
    // 但我們至少知道有誰在。
    // *進階作法*：如果想要即時更新身分，可以在後端 update_players 時，特地發一份給 admin_sid。
    // *簡單作法*：上帝想看最新狀態時，按一下「查兇手」，後端再補發一次 admin_login_success 類型的封包即可。
});