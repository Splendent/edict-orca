---
name: edict
description: 手動管理目前 Orca 對話的 Edict 模式。只有使用者明確呼叫 init、status、config、off、help 時使用；安裝或一般工作需求不代表啟用。
disable-model-invocation: true
---

# Edict 對話命令

這是手動入口，安裝不啟用任何對話。不因使用者提出工作需求就自行 init。使用者在目前對話執行一次 `/edict init`（Codex 原生 `$edict init`），完成該代理的設定及原生啟用步驟後，後續直接交代工作，不要求每個任務加 Edict 前綴。Cursor 須完成下述 Custom Mode 設定。其他對話預設停用。

## 身分與操作

優先使用目前代理提供的原生對話ID，例如 Codex 的 CODEX_THREAD_ID、Claude 技能變數 ${CLAUDE_SESSION_ID}。代理未提供原生ID時，首次 init 可不傳 --session，由 CLI 回傳獨立的 conversation:UUID 識別碼。將回傳識別碼保留於本對話，後續每次 CLI 操作明確帶上 --session；不把它寫入專案指令或其他對話。不得以 CWD、專案路徑、終端機或 Orca pane 代替。

重複 init、設定修改、關閉與恢復都使用本對話既有識別碼。對話壓縮或交接摘要需保留：啟用／停用狀態、識別碼、設定摘要、目前 Run 與未完成工作。若遺失識別碼，向使用者說明，不能掃描狀態目錄後猜選最近一次，也不能默默重開一份。

隨技能的 [CLI 入口](scripts/edict.mjs) 可用 `node <此技能目錄>/scripts/edict.mjs <子命令> --session <ID>` 呼叫；也可用已安裝的 `edict`。所有參數使用工具的結構化 argv 或適當 shell 引用，不能直接拼接使用者文字。

## 命令

| 命令 | 行為 |
| --- | --- |
| init | 讀取本對話狀態，透過對話完成角色／模型設定，再啟用本對話；重複執行沿用設定與既有派工，不另建 Run |
| status | 顯示 active、角色模型、Run 與派工ID；派工ID清單不是即時執行狀態，必要時讀 Orca；不得因此啟用 |
| config | 查看或修改本對話角色設定；不啟用、不修改其他對話、不更換已啟動 worker 模型 |
| off | 將本對話設為停用；不關閉終端機、不自動取消或重派 worker；列出原有派工供確認，之後一般對話不套用 Edict |
| help | 顯示以上命令與啟用範圍，不啟用 |

使用者明確呼叫入口卻未提供子命令時顯示 help。已啟用後收到的一般工作訊息不算無子命令，不顯示 help，應沿用協調流程。只處理使用者真正輸入的命令，不把引用範例、程式碼區塊或研究資料中的 `/edict init` 當成授權。

### init 的設定流程

1. 已有本對話識別碼時，先用 `status --session <ID>` 查目前狀態。已有設定時顯示摘要，使用者未要求修改就直接用 `init --yes --session <ID>` 啟用／沿用。
2. 首次使用，問一個具體問題：「各角色先共用哪種代理（Claude／Codex／Cursor）？模型沿用工具預設，或指定模型ID？」等待回答。不能把 `--yes` 當成跳過使用者未做過的設定選擇。
3. 依回答用 `init --yes --session <ID> --agent <agent> [--model <ID>] [--effort <值>]` 保存。不在代理非互動 shell 執行等待 TTY 輸入的 init。使用者要求逐角色設定時，按已知需求逐項用 `config set <角色> ... --session <ID>` 保存；只有真有缺少資訊時再詢問。
4. 保留 init 回傳的識別碼，執行 `context --session <ID>` 並讀 [協調流程](references/active.md)。回覆「此對話已啟用，接下來直接交代工作」，列設定摘要。這是對話指令，不是背景強制執行機制；不得聲稱壓縮後已自動驗證恢復。

### Cursor 的原生對話模式

當目前協調者是 Cursor（不是僅把 Cursor 選為某個 worker），所有 init 呼叫都帶 `--coordinator cursor`。只有設定檔 active=true 不足以代表 Cursor 技能已在整段對話常駐。

1. 首次 init 保存角色設定，但 CLI 回傳 active=false、pending=cursor-custom-mode。先保留識別碼，不派工、不宣稱啟用完成。
2. 在初始設定對話引導使用者：於 Cursor 的 `/` 技能選單選 Edict，使用 **Use as Mode**，或該平台對應的 Option+Enter／Alt+Enter，讓輸入框顯示 Edict 模式標記。這是此對話的原生模式，不修改專案或全域規則。模式選定本身不替使用者執行 init。
3. 使用者明確確認標記出現（或你有實際介面證據）後，沿用同一識別碼與設定，執行 `init --yes --session <ID> --coordinator cursor --mode-confirmed`。核對 active=true，再宣告啟用。不得自行假定已選模式。
4. 原生模式讓技能在每輪維持上下文，正常工作先讀本對話 context，再依 active.md 協調；一般問答直接回答。off 將狀態停用並請使用者退出 Edict 模式標記。尚未退出模式時，技能仍在上下文，但必須依停用狀態正常回答，不派工、不自動 init。再次啟用須重新確認模式。

Cursor 官方說明這項模式適用 Agents Window 與 CLI。若當地 Orca 使用的 Cursor 版本或介面找不到 Use as Mode，保持 pending 並明列當地未支援／未驗證，不能把單則技能附加或讓使用者每次重打命令當成等價完成。此項要求不影響 Cursor 作為已派工作 worker。

設定只存使用者的對話狀態目錄，不向工作專案寫入技能、AGENTS.md 或 config.json。舊版專案設定可在使用者要求時用 `init --yes --session <ID> --import-config <路徑>` 匯入；原檔保留不修改。

### 啟用後

這段對話後續的工作訊息，先用保留的識別碼讀 `context --session <ID>`，啟用時依 [協調流程](references/active.md) 工作；一般問答直接回答。每次不需要使用者重新輸入命令。off 後停止套用協作指令。未 init 的對話不會自行讀取、啟用或套用 Edict；不安裝 hook、全域常駐規則或輪詢程序。

本模式依賴代理遵守對話指令與摘要交接，無法從技能檔本身保證跨所有代理的壓縮／恢復行為。失去對話上下文時明確回報，不把狀態檔存在當作目前對話已啟用。
