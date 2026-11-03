# 來源與移植範圍

來源：[cft0808/edict](https://github.com/cft0808/edict)，核對版本 `14a207557719c046af0f993a7bff1cc5a5015b33`。本版依原始 `agents/*/SOUL.md` 改寫職責與協作流程，保留 MIT 授權聲明。

本版是獨立的命令列與技能套件，供既有 Orca 對話使用。角色通訊改用 Orca Task、Dispatch、ask、reply 與 worker_done；不依賴 OpenClaw 的 sessions_send、subagent 呼叫、看板更新或 Gateway。

原始角色職責依各自 SOUL.md：兵部負責工程開發，工部負責基礎設施。原版尚書省派工表有相反描述，本版以部門自己的職責為準。欽天監與早朝官依各自來源分開保留，按需求使用。

目前對話履行太子與協調者的操作職責；中書省、門下省、尚書省及執行部門仍可分別指定代理與模型。worker 專注單次職責，實際角色間轉交由目前對話負責，避免巢狀協調者另開工作流程。原版第三輪強制准奏改為最多三輪仍未通過即回報阻礙。角色限制由技能指令約定，未聲稱有額外系統層 ACL 或強制狀態機。

使用者指定沿用目前對話，因此本套件不攜帶原版網頁看板、HTTP API、飛書／Telegram 通知、Redis／SQL 後端、新聞排程及 OpenClaw 安裝器。早朝官只在明確研究任務中使用，不自行排程。來源暫存檢出未修改。

介面依本機 Orca `1.4.246` 的 `skills get orchestration`、`worker-start --help`、`send --help` 及 `status --json` 核對；執行時仍須載入本機版本指南。

技能目錄依據：

- Cursor：https://cursor.com/docs/skills
- Claude Code：https://code.claude.com/docs/en/skills
- Codex：本次環境提供的 skill-creator 技能格式與 `.agents/skills` 既有共用位置。
