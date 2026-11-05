# 來源與移植範圍

來源：[cft0808/edict](https://github.com/cft0808/edict)，核對版本 `14a207557719c046af0f993a7bff1cc5a5015b33`。依原始 `agents/*/SOUL.md` 改寫職責與協作流程，保留 MIT 授權聲明。

本套件供既有 Orca 對話使用，不依賴 OpenClaw 的 sessions_send、看板、Gateway 或其他原生 API。角色交涉、原生工作與回報使用 Orca Run、Task、Dispatch、send、ask、reply 與 worker_done。

原對話履行太子與 root 控制責任。root 建立三省平行頭領，其中門下與尚書先沒有工作授權；中書提出方案後授予既有門下 scope，門下批准後才授予既有尚書實作 scope。尚書管理六部尚書，各部尚書管理郎中。中書舍人、給事中及郎中不得再建立下層代理。原生深度至少 3，由使用者在 Orca 正式設定介面確認，不修改 App 設定檔繞過限制。

兵部負責工程實作，工部負責建置及基礎設施；原版尚書派工表有相反描述，本套件依各部 SOUL.md 的職責。刑部保留獨立成果、測試及合規驗收。欽天監、早朝官的角色設定保留，本階層入口不賦予其三省六部管理權；不自行排程或通知。

Edict CLI 依原生呼叫身分核對成員、scope、世代及核可，分別保存 plan-approval、artifact-acceptance、closure-confirmation。原生 Task 成功不取代門下放行、刑部驗收或門下結案；第三輪不得強制批准。這些入口檢查不是 OS 沙箱，也不能阻止同帳號代理直接繞過 Edict 使用其他工具。

目前工作目錄使用全新 v2 session、config 與工作資料；舊版遷移、相容派工、跨版本續辦及降版不在範圍。資料不支援時拒絕，不自動刪除使用者原狀態。

介面與控制實作參考本機 Orca 1.4.249 指南與原生程式；已在 macOS／Codex 以有界報告任務完成三省交接、部尚書及郎中、刑部驗收、門下結案與限定範圍取消。跨所有代理、恢復及取消交錯未全測，版本號不代表已發布；具體證據及限制見 README。

不攜帶原版網頁看板、HTTP API、飛書／Telegram 通知、Redis／SQL 後端、新聞排程或 OpenClaw 安裝器。不註冊 hook、不建立背景輪詢；啟用依手動技能與明確對話身分延續。

技能目錄與手動入口依據：

- Cursor：https://cursor.com/docs/skills
- Claude Code：https://code.claude.com/docs/en/skills
- Codex：https://learn.chatgpt.com/docs/build-skills

保留 SKILL.md 的 `disable-model-invocation` 與既有 agents/openai.yaml 的 `allow_implicit_invocation: false`。通用驗證器不接受前者時，只在暫存副本移除該欄位以驗證其餘格式，不改正式手動入口政策，也不產生額外 metadata。
