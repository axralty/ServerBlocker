/**
 * @name ServerBlocker
 * @author axy
 * @authorLink https://github.com/axralty
 * @source https://github.com/axralty
 * @description Prevent accessing blocked servers entirely.
 * @version 2.0.0
 */

module.exports = class ServerBlocker {
    constructor() {
        this.blockedServers = [];
        this._badgeInterval = null;
        this._routerUtils = null;
        this._voiceModule = null;
        this._disconnecting = false;
    }

    start() {
        this.blockedServers = BdApi.Data.load("ServerBlocker", "blockedServers") || [];
        this._routerUtils = this._findModule([
            m => Object.values(m).some(v => { try { return typeof v === "function" && v.toString().includes("Transitioning to"); } catch { return false; } }),
            m => !!(m?.transitionTo || m?.replaceWith || m?.goBack),
        ]);
        this._voiceModule = this._findModule([
            m => typeof m?.selectVoiceChannel === "function" && typeof m?.disconnect === "function",
            m => typeof m?.default?.selectVoiceChannel === "function" && typeof m?.default?.disconnect === "function",
        ], true);
        this._patchAll();
        this._startBadgeLoop();
        this._buildFloatingButton();
    }

    stop() {
        BdApi.Patcher.unpatchAll("ServerBlocker");
        clearInterval(this._badgeInterval);
        document.getElementById("sb-blocked-banner")?.remove();
        document.removeEventListener("mousemove", this._onMouseMove);
        document.removeEventListener("mouseup", this._onMouseUp);
        document.getElementById("sb-floating-btn")?.remove();
        document.getElementById("sb-floating-panel")?.remove();
    }

    _findModule(predicates, resolveDefault = false) {
        for (const pred of predicates) {
            try {
                const m = BdApi.Webpack.getModule(pred);
                if (m) return resolveDefault && m.default?.selectVoiceChannel ? m.default : m;
            } catch {}
        }
        return null;
    }

    _patchAll() {
        this._patchNavigation();
        this._patchInviteAccept();
        this._patchVoiceJoin();
    }

    _patchNavigation() {
        const ru = this._routerUtils;
        if (!ru) return console.warn("[ServerBlocker] RouterUtils not found");

        const findKey = (...strings) => Object.keys(ru).find(k => {
            if (typeof ru[k] !== "function") return false;
            try { const s = ru[k].toString(); return strings.some(str => s.includes(str)); }
            catch { return false; }
        });

        const transitionKey = findKey("transitionTo - Transitioning to", "Transitioning to", "/channels/")
            || (ru.transitionTo && "transitionTo") || (ru.navigate && "navigate");

        const guildKey = findKey("transitionToGuild - Transitioning to", "transitionToGuild")
            || (ru.transitionToGuild && "transitionToGuild");

        if (transitionKey) {
            BdApi.Patcher.instead("ServerBlocker", ru, transitionKey, (_, args, orig) => {
                const match = typeof args[0] === "string" && args[0].match(/^\/channels\/(\d+)/);
                const gid = match?.[1];
                if (gid && gid !== "@me" && this.isBlocked(gid)) {
                    BdApi.UI.showToast(`🚫 "${this._guildName(gid)}" is blocked — access denied.`, { type: "error", timeout: 3000 });
                    return;
                }
                return orig(...args);
            });
        } else console.warn("[ServerBlocker] transitionTo key not found");

        if (guildKey) {
            BdApi.Patcher.instead("ServerBlocker", ru, guildKey, (_, args, orig) => {
                if (args[0] && this.isBlocked(args[0])) {
                    BdApi.UI.showToast(`🚫 "${this._guildName(args[0])}" is blocked — access denied.`, { type: "error", timeout: 3000 });
                    return;
                }
                return orig(...args);
            });
        }
    }

    _patchInviteAccept() {
        const m = BdApi.Webpack.getModule(m => m?.acceptInvite);
        if (!m) return console.warn("[ServerBlocker] InviteActions not found");

        BdApi.Patcher.instead("ServerBlocker", m, "acceptInvite", (_, args, orig) => {
            const invite = args[0];
            const code = typeof invite === "string" ? invite : invite?.code;
            let gid = invite?.guild?.id || invite?.guildId || null;

            if (!gid && code) {
                gid = BdApi.Webpack.getStore("InviteStore")?.getInvite?.(code)?.guild?.id || null;
            }
            if (!gid && code) {
                try {
                    const r = BdApi.Webpack.getModule(m => m?.resolveInvite || m?.getInvite);
                    gid = r?.resolveInvite?.(code)?.guild?.id || r?.getInvite?.(code)?.guild?.id || null;
                } catch {}
            }

            if (gid && this.isBlocked(gid)) {
                BdApi.UI.showToast("🚫 This server is blocked — cannot join.", { type: "error", timeout: 3000 });
                return;
            }
            return orig(...args);
        });
    }

    _patchVoiceJoin() {
        const va = BdApi.Webpack.getModule(m => m?.selectVoiceChannel) || this._voiceModule;
        if (va?.selectVoiceChannel) {
            BdApi.Patcher.instead("ServerBlocker", va, "selectVoiceChannel", (_, args, orig) => {
                if (args[0] && this.isBlocked(this._guildFromChannel(args[0]))) {
                    BdApi.UI.showToast("🚫 Voice is blocked in this server.", { type: "error", timeout: 3000 });
                    return;
                }
                return orig(...args);
            });
        } else console.warn("[ServerBlocker] selectVoiceChannel not found");

        const ca = BdApi.Webpack.getModule(m => typeof m?.selectChannel === "function" && typeof m?.selectVoiceChannel === "function");
        if (ca?.selectChannel) {
            BdApi.Patcher.instead("ServerBlocker", ca, "selectChannel", (_, args, orig) => {
                const isObj = typeof args[0] === "object";
                const gid = (isObj ? args[0]?.guildId : args[0]) || this._guildFromChannel(isObj ? args[0]?.channelId : args[1]);
                if (gid && gid !== "@me" && this.isBlocked(gid)) {
                    BdApi.UI.showToast("🚫 This server is blocked.", { type: "error", timeout: 3000 });
                    return;
                }
                return orig(...args);
            });
        }

        const callMod = BdApi.Webpack.getModule(m => typeof m?.acceptCall === "function" || typeof m?.joinCall === "function");
        if (callMod) {
            const fn = callMod.acceptCall ? "acceptCall" : "joinCall";
            BdApi.Patcher.instead("ServerBlocker", callMod, fn, (_, args, orig) => {
                const cid = typeof args[0] === "object" ? args[0]?.channelId : args[0];
                if (cid && this.isBlocked(this._guildFromChannel(cid))) {
                    BdApi.UI.showToast("🚫 Voice invite blocked — server is blocked.", { type: "error", timeout: 3000 });
                    return;
                }
                return orig(...args);
            });
        }
    }

    _forceDisconnect() {
        const attempts = [
            () => this._voiceModule?.disconnect?.(),
            () => BdApi.Webpack.getModule(m => typeof m?.selectVoiceChannel === "function" && typeof m?.disconnect === "function")?.disconnect?.(),
            () => BdApi.Webpack.getModule(m => m?.default && typeof m.default.disconnect === "function")?.default?.disconnect?.(),
            () => BdApi.Webpack.getModule(m => typeof m?.disconnect === "function" && typeof m?.setAudioInputMode === "function")?.disconnect?.(),
            () => BdApi.Webpack.getModule(m => typeof m?.selectVoiceChannel === "function")?.selectVoiceChannel?.(null),
        ];
        for (const attempt of attempts) {
            try { if (attempt() !== undefined) return true; } catch {}
        }
        console.warn("[ServerBlocker] All disconnect strategies failed");
        return false;
    }

    _disconnectIfBlocked() {
        try {
            const uid = BdApi.Webpack.getStore("UserStore")?.getCurrentUser()?.id;
            if (!uid) return false;
            const cid = BdApi.Webpack.getStore("VoiceStateStore")?.getVoiceStateForUser(uid)?.channelId;
            if (!cid || !this.isBlocked(this._guildFromChannel(cid))) return false;
            if (this._forceDisconnect()) {
                BdApi.UI.showToast("🚫 Disconnected from blocked server's voice.", { type: "error", timeout: 3000 });
                return true;
            }
        } catch (e) { console.warn("[ServerBlocker] _disconnectIfBlocked failed", e); }
        return false;
    }

    isBlocked(gid) { return !!gid && this.blockedServers.some(s => s.id === gid); }

    _guildName(gid) {
        try { return BdApi.Webpack.getStore("GuildStore")?.getGuild(gid)?.name || gid; } catch { return gid; }
    }

    _currentGuildId() {
        try { return BdApi.Webpack.getStore("SelectedGuildStore")?.getGuildId() || null; } catch { return null; }
    }

    _guildFromChannel(cid) {
        try { return BdApi.Webpack.getStore("ChannelStore")?.getChannel(cid)?.guild_id || null; } catch { return null; }
    }

    _save() { BdApi.Data.save("ServerBlocker", "blockedServers", this.blockedServers); }

    _navigateHome() {
        if (!this._routerUtils) return;
        const ru = this._routerUtils;
        const key = Object.keys(ru).find(k => {
            try { const s = ru[k]?.toString(); return typeof ru[k] === "function" && (s.includes("Transitioning to") || k === "transitionTo" || k === "navigate"); }
            catch { return false; }
        });
        if (key) try { ru[key]("/channels/@me"); } catch {}
    }

    _startBadgeLoop() {
        this._badgeInterval = setInterval(() => {
            const gid = this._currentGuildId();
            const banner = document.getElementById("sb-blocked-banner");

            if (gid && this.isBlocked(gid)) {
                if (!banner) {
                    const el = Object.assign(document.createElement("div"), { id: "sb-blocked-banner", textContent: "🚫 BLOCKED SERVER" });
                    el.style.cssText = "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9999;background:#ed4245;color:#fff;font-size:13px;font-weight:600;padding:6px 16px;border-radius:8px;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.4)";
                    document.body.appendChild(el);
                }
            } else {
                banner?.remove();
            }

            const uid = BdApi.Webpack.getStore("UserStore")?.getCurrentUser()?.id;
            const vcid = uid && BdApi.Webpack.getStore("VoiceStateStore")?.getVoiceStateForUser(uid)?.channelId;
            if (vcid && this.isBlocked(this._guildFromChannel(vcid)) && !this._disconnecting) {
                this._disconnecting = true;
                this._disconnectIfBlocked();
                setTimeout(() => { this._disconnecting = false; }, 5000);
            } else if (!vcid) {
                this._disconnecting = false;
            }
        }, 1000);
    }

    _buildFloatingButton() {
        const btn = Object.assign(document.createElement("div"), { id: "sb-floating-btn" });
        btn.style.cssText = `position:fixed;bottom:80px;right:20px;width:44px;height:44px;border-radius:50%;background:url("https://cdn-icons-png.flaticon.com/512/7596/7596460.png") center/cover no-repeat;cursor:pointer;z-index:9998;user-select:none`;

        let dragging = false, startX, startY, startLeft, startBottom, moved = false;

        btn.onmousedown = e => {
            dragging = true; moved = false;
            startX = e.clientX; startY = e.clientY;
            startLeft = btn.getBoundingClientRect().left;
            startBottom = window.innerHeight - btn.getBoundingClientRect().bottom;
            e.preventDefault();
        };

        this._onMouseMove = e => {
            if (!dragging) return;
            const dx = e.clientX - startX, dy = e.clientY - startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
            btn.style.left = Math.max(0, Math.min(window.innerWidth - 44, startLeft + dx)) + "px";
            btn.style.right = "auto";
            btn.style.bottom = Math.max(0, Math.min(window.innerHeight - 44, startBottom - dy)) + "px";
        };

        this._onMouseUp = () => {
            if (!dragging) return;
            dragging = false;
            if (!moved) this._openPanel();
        };

        document.addEventListener("mousemove", this._onMouseMove);
        document.addEventListener("mouseup", this._onMouseUp);
        document.body.appendChild(btn);
    }

    _openPanel() {
        document.getElementById("sb-floating-panel")?.remove();

        const overlay = Object.assign(document.createElement("div"), { id: "sb-floating-panel" });
        overlay.style.cssText = "position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6)";

        const panel = document.createElement("div");
        panel.style.cssText = "background:rgba(155,155,155,.85);border-radius:12px;padding:20px;width:420px;max-height:80vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.6)";

        const mk = (tag, style, text) => {
            const el = document.createElement(tag);
            if (style) el.style.cssText = style;
            if (text != null) el.textContent = text;
            return el;
        };

        const header = mk("div", "display:flex;align-items:center;justify-content:space-between;margin-bottom:16px");
        const closeBtn = mk("button", "background:transparent;border:none;color:#000;font-size:28px;cursor:pointer;padding:2px 6px;border-radius:4px", "✕");
        closeBtn.onclick = () => overlay.remove();
        header.append(mk("div", "font-size:16px;font-weight:700;color:#000", "🚫 Server Blocklist"), closeBtn);

        const btnStyle = "background:#9099ff;color:#000;border:1px solid #000;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600";
        const addCurrentBtn = mk("button", btnStyle + ";margin-bottom:12px;display:block;width:100%", "＋ Block Current Server");
        addCurrentBtn.onclick = () => {
            const gid = this._currentGuildId();
            if (!gid) return BdApi.UI.showToast("No server selected!", { type: "warning" });
            if (this.isBlocked(gid)) return BdApi.UI.showToast("Already blocked.", { type: "warning" });
            const name = this._guildName(gid);
            this.blockedServers.push({ id: gid, name });
            this._save(); renderList();
            BdApi.UI.showToast(`✅ Blocked: ${name}`, { type: "success" });
            this._disconnectIfBlocked();
            this._navigateHome();
            overlay.remove();
        };

        const inputStyle = "flex:1;padding:8px 10px;border-radius:6px;border:1px solid #000;background:rgba(0,0,0,.5);color:#fff;font-size:13px";
        const manualRow = mk("div", "display:flex;gap:8px;margin-bottom:16px");
        const idInput = mk("input", inputStyle); idInput.placeholder = "Server ID";
        const nameInput = mk("input", inputStyle); nameInput.placeholder = "Label (optional)";
        const addBtn = mk("button", btnStyle, "Add");
        addBtn.onclick = () => {
            const id = idInput.value.trim();
            if (!id) return BdApi.UI.showToast("Enter a server ID.", { type: "error" });
            if (this.isBlocked(id)) return BdApi.UI.showToast("Already blocked.", { type: "warning" });
            this.blockedServers.push({ id, name: nameInput.value.trim() || id });
            this._save();
            idInput.value = nameInput.value = "";
            renderList();
            BdApi.UI.showToast("✅ Added to blocklist.", { type: "success" });
        };
        manualRow.append(idInput, nameInput, addBtn);

        const list = mk("div", "display:flex;flex-direction:column;gap:6px");

        const renderList = () => {
            list.innerHTML = "";
            if (!this.blockedServers.length) {
                list.appendChild(mk("div", "font-size:13px;color:#000;padding:12px 0", "No servers blocked yet."));
                return;
            }
            for (const server of this.blockedServers) {
                const row = mk("div", "display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:rgba(0,0,0,.5);border-radius:8px;border:1px solid rgba(0,0,0,.5)");
                const info = document.createElement("div");
                info.append(
                    mk("div", "font-size:13px;font-weight:600;color:#000", server.name),
                    mk("div", "font-size:13px;color:#000;font-family:monospace", server.id)
                );
                const removeBtn = mk("button", "background:transparent;color:#ff0004;border:1px solid #ff0004;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;font-weight:600", "Unblock");
                removeBtn.onclick = () => {
                    this.blockedServers = this.blockedServers.filter(s => s.id !== server.id);
                    this._save(); renderList();
                    BdApi.UI.showToast(`Unblocked: ${server.name}`, { type: "info" });
                };
                row.append(info, removeBtn);
                list.appendChild(row);
            }
        };

        panel.append(
            header, addCurrentBtn, manualRow,
            mk("div", "font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#888;margin-bottom:8px", "Blocked Servers"),
            list
        );
        renderList();
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
    }

    getSettingsPanel() {
        const p = document.createElement("div");
        p.style.cssText = "padding:16px";
        p.innerHTML = `<p style="font-size:13px;color:var(--text-muted)">Use the floating button in Discord to manage blocked servers.</p>`;
        return p;
    }
};