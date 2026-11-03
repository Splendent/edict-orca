# Edict for Orca

在目前對話執行一次 `/edict init`，完成角色與模型設定後，正常交代工作。這段對話依 Edict 規劃、獨立審核、派工與驗收；一般問答直接回答。其他對話預設未啟用。套件不安裝 hook、常駐規則或輪詢程序。

Claude Code、Cursor 使用 `/edict init`；Codex 原生技能入口是 `$edict init`。Cursor 的初次設定包含將 Edict 選為此對話的 Custom Mode，見下節。不宣稱能替 Codex CLI 新增任意原生斜線命令。

## 安裝

需要 Node.js 20 以上、Git、可用的 Orca 與已登入代理，以及有儲存庫權限的 GitHub 帳號。每台電腦安裝一次：

```sh
gh repo clone Splendent/edict-orca
cd edict-orca
node scripts/install-local.mjs
```

安裝器建立使用者層級命令與共用手動技能，連結到各代理技能目錄，不啟用對話，也不修改代理 settings、hook 或工作專案。可用 `--dry-run` 查看變動。若 ~/.local/bin 不在 PATH，先加入該目錄；也可用 `node <儲存庫路徑>/bin/edict.mjs`。

既有對話未發現新技能時，可直接請代理讀取安裝位置的 SKILL.md，不必改工作專案。

## 對話命令

| 命令 | 用途 |
| --- | --- |
| `/edict init` | 設定並啟用目前對話，接下來正常交代工作 |
| `/edict status` | 查看本對話開關、角色模型及 Orca 派工紀錄 |
| `/edict config` | 調整本對話角色設定，只影響之後啟動的 worker |
| `/edict off` | 停用本對話，保留紀錄；不取消已派工作 |
| `/edict help` | 顯示用法，不啟用 |

Codex 將 `/edict` 換成 `$edict`。不用每次任務重複命令。引用文件或程式碼中的命令不代表授權啟用。

## Cursor 持續啟用

Cursor 的一般技能呼叫只附於單則訊息。初次 `/edict init` 保存設定後，代理會請你在 `/` 技能選單為 Edict 選 **Use as Mode**，或使用介面對應的 Option+Enter／Alt+Enter。確認輸入框出現 Edict 模式標記後，代理完成本次 init；之後正常交代工作，不必每次附加技能。

CLI 將此過程保存為 active=false、pending=cursor-custom-mode，確認原生模式選定後才改成 active=true；未完成時拒絕派工。off 會停用狀態，並提示退出模式標記。模式未退出前也必須遵守停用狀態，不會自動恢復流程。

[Cursor 原生模式文件](https://cursor.com/docs/agent/prompting) 說明 Agents Window 與 CLI 都支援 Custom Mode；當地 Orca 使用的版本與介面仍須實際確認。有版本無法選定模式時，init 保持待完成，不宣稱已達成持續啟用。

## 狀態與設定

首次 init 優先使用代理提供的原生對話ID；沒有時回傳獨立的 conversation:UUID 識別碼。代理將識別碼保留在本對話，後續 CLI 明確沿用，並在壓縮摘要保留開關、識別碼、角色設定及目前 Run。不得以專案或終端機判定對話，也不掃描並猜選最近狀態。識別碼遺失時須回報，不默默重設。

狀態保存於 ~/.config/edict/sessions，以 SHA-256 命名並限制權限；EDICT_HOME 可更換位置。修改 A 對話不改 B。這是供代理依對話指令讀取的資料，沒有背景機制自動注入。技能無法保證所有代理在壓縮後都正確延續指令，必須實測，遺失上下文時明列限制。

各角色可選 Claude、Codex、Cursor 與使用者指定模型；未指定模型沿用工具預設。不自動換供應商或降級。改設定不會更換執行中的 worker 模型。

## Orca 與 CLI

目前對話負責協調，不另開主對話。派工經 Orca worker-start，任務從 stdin 傳入；ask、reply、worker_done、喚醒及復原依執行主機的版本對應指南。派工狀態以 Orca 為準；本套件只保存收據索引。

工作按可獨立驗收的單位與真正相依拆分；門下可逐項放行，共同介面或安全前提未齊的相關單位仍須等待。同角色可以有多個獨立執行者，同任務修正續辦原角色；尚書收到部分成果就核對與增量彙整，刑部可先驗獨立成果，最後仍需整體整合驗收。

代理內部工具：`task-create` 建立具有原生 deps 的 Task，`dispatch --task` 啟動既有 Task，`dispatch-ready` 在核可派工表中並行啟動已就緒且不衝突的工作，`continue` 交還原 Dispatch 並保存後續收據。操作格式與放行聲明限制見 [相依派工工具](skills/edict/references/scheduling.md)。工具不代替門下判斷、不常駐、不輪詢，也不把結果未知當成可重試。

使用者通常只需對話命令。以下供代理操作，識別碼與模型需換成實際值：

```sh
edict init --yes --agent codex
edict status --session conversation:RETURNED_ID
edict config set menxia --session conversation:RETURNED_ID --agent claude --model MODEL_ID
edict dispatch zhongshu --session conversation:RETURNED_ID --spec-file /tmp/edict-plan.txt --dry-run
edict off --session conversation:RETURNED_ID
```

首次設定由代理透過對話詢問後保存；--yes 不代表代替使用者選擇模型。重複 init 時需沿用已保存的 --session，避免建立另一份狀態。Codex 環境有 CODEX_THREAD_ID 時可自動辨識。

## 更新與舊版

```sh
git pull --rebase
node scripts/install-local.mjs
```

安裝連結指向本機儲存庫，不必向各工作專案複製技能。0.1 版專案檔案不自動刪除或覆寫，僅限在本對話首次 init 前，由代理依使用者要求用 `init --yes --session <ID> --import-config <舊config.json>` 匯入設定。已有設定的對話改用 `edict config set <角色> --session <ID> ...` 逐角色調整，不能再次匯入覆寫。舊版同名專案技能可能仍被讀取，升級時應先備份並停用，避免入口混用。本版不擅自刪除專案檔案。

每台電腦各自登入代理；GitHub 分享程式，不分享對話狀態或憑證。

## 驗證

```sh
npm test
npm run check
```

測試包含對話隔離、開關、設定與模型參數、失敗不重派，以及安裝不修改代理設定。模擬 Orca 不能證明供應商接受特定模型；技能指令不能代替各代理多輪對話與壓縮後的實測。Windows 與 Linux 仍須另外驗證。

角色來源與適用範圍見 [NOTICE.md](NOTICE.md)。

## 狀態鎖檔與收據恢復

寫入狀態時，鎖檔記錄本機程序 PID、建立時間及主機名稱。同主機的持有程序已不存在時，下一次 init、config 或 off 會清除殘留鎖後重試；空白或無有效資訊的舊鎖需超過 30 秒才處理，讓新鎖有時間寫入資訊。程序仍存在、主機不同或無法確認時不依鎖齡強制清除，最多等待 500 毫秒後回報鎖檔路徑。可先確認持有程序是否仍在寫入；不要直接刪除活躍鎖。此恢復機制尚未驗證跨主機共用狀態目錄的情形。

派工收到 Orca 回應但狀態寫入失敗時，CLI 仍輸出原始收據，並嘗試另存到 EDICT_HOME/receipts（預設 ~/.config/edict/receipts），stderr 顯示檔案路徑。協調者應保存收據、向 Orca 核對 Run／Task／Dispatch，待狀態可寫後補記；不能重新派出同一工作。若備份也因磁碟或權限失敗，須保存 stdout 的原始收據，不能只依 status 缺少紀錄判定派工未發生。
