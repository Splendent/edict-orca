---
name: edict
description: 手動管理目前 Orca 對話的 Edict 模式。只有使用者明確呼叫 init、status、config、off、update、help 時使用；安裝或一般工作需求不代表啟用。
disable-model-invocation: true
---

# Edict 對話命令

這是手動入口。使用者明確 init、選擇代理／模型並完成啟用後，才在目前對話依 Edict 協作；一般問答直接回答。Claude Code／Cursor 使用 `/edict init`，Codex 使用 `$edict init`。不安裝 hook、背景輪詢或常駐指令，不自行啟用其他對話。

## 對話身分與資料

優先使用代理的原生對話 ID，例如 CODEX_THREAD_ID 或 Claude 原生技能提供的對話 ID。缺少時首次 init 可回傳 `conversation:UUID`。後續每次 CLI 明確帶同一 `--session`，並保留同一 EDICT_HOME；不以工作目錄、專案或終端機冒充對話，不掃描最近狀態猜選。壓縮摘要保留 active、session、EDICT_HOME、設定、Run 與未完成操作；遺失時回報，不重建。

只接受 v2 session、config 與工作資料，不匯入 v1，不自動遷移或刪除原資料。使用獨立新 EDICT_HOME 驗證這份實作；需將同一路徑交給所有下屬。原有 v1 工作保留在原環境，不切換其在途 CLI。

可用已安裝的 `edict`，或 [隨技能 CLI](scripts/edict.mjs)：`node <技能絕對路徑>/scripts/edict.mjs <子命令> --session <ID>`。用工具的結構化 argv 或正確引用，不將含反引號、`$()` 的任務拼進 shell。

## 使用者命令

| 命令 | 行為 |
| --- | --- |
| init | 互動確認設定後啟用此對話；再次啟用沿用原 ID 與資料 |
| status | 查看開關、角色與協作工作摘要，不啟用 |
| config | 調整本對話角色／職位設定，僅影響新派工 |
| off | 停止新派工與推進，保留資料及在途回報，不自動取消程序 |
| update | 手動更新共用安裝，核對資料格式，再由本對話重讀 |
| help | 顯示說明，不啟用 |

明確呼叫入口卻未給子命令時顯示 help。已啟用後的一般工作要求照協調流程處理，不要求每次重打命令；引用範例不構成授權。

## 初始化與模型

1. 已有 session 先讀 status，保存的 v2 設定有效且使用者未要求改動時，用同一 ID `init --yes --session <ID>` 沿用。
2. 首次問：「各角色先共用哪種代理（Claude／Codex／Cursor）？模型使用工具預設，或指定哪個模型 ID？」等待明確回答，不自選供應商、模型或推理強度。
3. 按回答保存：`init --yes --session <ID> --agent <已選代理> [--model <已選模型>] [--effort <已選強度>]`。缺原生 ID 時首次省略 session，保留 CLI 回傳值。不要在代理非互動 shell 等待 TTY 問答。
4. 保存後讀 `context --session <ID>`，只在 active=true 時讀 [協調流程](references/active.md)；回報目前對話已啟用及設定摘要。

逐角色設定使用 `config set <role>`；職位設定加 `--position head|executor`，移除整組覆寫用 `--position <職位> --inherit`。職位覆寫未設定即繼承角色整組，null model 表示該代理工具預設。換供應商不保留原模型，改模型清除舊 effort；不因繁忙而自動降級。首次不必逐一詢問職位覆寫；有需求才詢問缺少值。完整 v2 設定匯入僅限首次 init，已有資料不得重複匯入覆寫。

## Cursor 模式

目前協調者是 Cursor 時，init 必須帶 `--coordinator cursor`。首次保存為 active=false、pending=cursor-custom-mode。請使用者在原生技能選單選 **Use as Mode**，確認輸入框模式標記；只有使用者明確確認或取得介面證據後，才沿用原 ID 執行 `init --yes --session <ID> --coordinator cursor --mode-confirmed`。

當地介面沒有這個模式時保持 pending 並回報限制，不用每則附加技能冒充持續啟用。off 後請使用者退出模式標記；即使尚未退出，仍遵守停用狀態，不自動 init。再次啟用重新確認；Cursor 作為 worker 不需這項協調者設定。

## 執行與控制

啟用後讀 [協調流程](references/active.md)；需要角色責任與 JSON 時讀 [工作契約](references/workflow.md)，派工／訊息／控制／結果未知時讀 [執行與恢復](references/scheduling.md)。三省由 root 建立平行空頭領，業務仍由中書送審、門下核可、尚書及六部執行。不要用舊 dispatch、task-create、dispatch-ready 或 continue；CLI 明確拒絕這些入口。

原生深度至少 3；不足時說明 **Settings → Orchestration → Nested worker depth**，由使用者確認，不改 App 設定檔。不要因拒絕、沉默或喚醒延後換 Run、重送派工或重設世代。pause／resume／cancel 依原對話明確要求與具體對象執行；resume 不清除取消，off 也不取消程序。

## 更新與重讀

更新僅在明確要求時執行。先核對目標版本支援 v2，以及所有共用安裝對話的未完成工作；不能用更新完成資料遷移。此工作目錄尚未發布，不承諾 `update` 會取得它，亦不承諾舊版在途 writer 相容。

用既有 session 執行 `edict update --session <ID>`；從未建立 session 時可只用 `edict update`，不為更新 init。更新器會拒絕來源不符、本機修改、未追蹤檔案、更新鎖及下載失敗；不自行 stash、reset、改遠端或重試。更新改變共用安裝的後續 CLI，其他對話不會自動重讀。

成功後依 `reload.files` 實際重讀 SKILL.md、active.md、scheduling.md、workflow.md，再讀原 session context；updated=false 仍需重讀。只有 active=true 才套用流程，停用或 pending 不變。不重派既有工作、不搬工作樹，不將切換檔案等同完整階層實測。終端機只更新檔案，不能向對話自動注入指令。
