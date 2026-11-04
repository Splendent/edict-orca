# Edict for Orca

將 [cft0808/edict](https://github.com/cft0808/edict) 的角色協作流程改編為既有 Orca 對話可用的命令列與手動技能。沿用目前對話，透過 Orca 派出 Claude Code、Codex 或 Cursor 代理，各角色可分別設定模型。本套件不包含原版網頁看板或 OpenClaw 執行環境；來源版本與改編範圍見 [NOTICE.md](NOTICE.md)。

目前版本為 **0.3.0-beta.1**，屬預覽版。支援範圍與尚未驗證事項見下表；不宣稱跨所有代理、平台及對話恢復方式都已驗證。

在目前對話執行一次 `/edict init`，完成角色與模型設定後，正常交代工作。這段對話依 Edict 規劃、獨立審核、派工與驗收；一般問答直接回答。其他對話預設未啟用。套件不安裝 hook、常駐規則或輪詢程序。

Claude Code、Cursor 使用 `/edict init`；Codex 原生技能入口是 `$edict init`。Cursor 的初次設定包含將 Edict 選為此對話的 Custom Mode，見下節。不宣稱能替 Codex CLI 新增任意原生斜線命令。

## 安裝

需要 Node.js 20 以上、Git、可用的 Orca，以及已登入的 Claude Code、Codex 或 Cursor。下載此公開儲存庫不需要 GitHub 帳號；使用代理仍須有各自的帳號與使用額度。Orca 介面已在 1.4.246 核對，其他版本以 `doctor` 的介面檢查及當地實測為準。

在要保留套件的目錄安裝固定版本，每台電腦一次。以下為 macOS／Linux shell 指令：

```sh
git clone --branch v0.3.0-beta.1 https://github.com/Splendent/edict-orca.git
cd edict-orca
node scripts/install-local.mjs --dry-run
node scripts/install-local.mjs
node bin/edict.mjs --version
```

安裝器建立使用者層級命令與共用手動技能，連結到各代理技能目錄，不啟用對話，也不修改代理設定、hook 或工作專案。若 ~/.local/bin 不在 PATH，先加入該目錄；也可用 `node <儲存庫路徑>/bin/edict.mjs`。固定 tag 的檢出不跟隨 main，更新時依下節切換版本。套件目錄是連結目標，安裝後須保留。

既有對話未發現新技能時，可直接請代理讀取安裝位置的 SKILL.md，不必改工作專案。

## 支援與驗證範圍

| 對象 | 驗證範圍 | 限制 |
| --- | --- | --- |
| macOS、Orca 1.4.246、Codex | 真實 Task 建立、原生相依、單項與平行派工、同角色續辦及收據索引 | 小型統計任務；未涵蓋完整多角色開發流程 |
| Claude Code、Cursor | 角色設定、模型參數與模擬 Orca 呼叫；手動入口設定 | 不代表兩者的真實多輪與壓縮恢復均已通過；Cursor 另須確認原生模式 |
| macOS／Ubuntu CI、Node.js 20／24 | 單元測試與語法檢查，狀態及設定使用臨時目錄 | 不啟動真實 Orca、不使用供應商憑證；結果以該版本的 [CI 紀錄](https://github.com/Splendent/edict-orca/actions) 為準 |
| Windows | 有命令入口與路徑處理程式 | 尚未完成當地安裝與真實協作驗證，不列入 CI 平台 |

`edict --version` 顯示套件版本，不需要啟用對話。`edict doctor --session <本對話ID>` 唯讀檢查 Orca 連線，以及基本派工、Task 相依、批次就緒查詢和續辦所需介面；不建立 Run／Task、不派工、不讀信箱。檢查成功不代表帳號額度、特定模型或完整工作流程已驗證。

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

一般派工使用 current，代理留在目前工作樹；讀寫範圍不衝突時也能在其中平行實作。需要隔離編輯時使用 new-child，在目前工作樹底下建立子工作樹；只有使用者明確要求獨立工作才用 new-top-level。同專案的 new-child 不需指定 repo，名稱可交由 Orca 決定。工作樹父子關係與 Run 監督關係分開，受派代理不會因此自動成為子工作樹。

| 層次 | 責任 |
| --- | --- |
| 目前對話 | 整理需求、讀取角色結論、轉交成果及回報 |
| Edict 技能 | 約定中書規劃、門下審查、尚書派工與彙整、部門執行、刑部驗收 |
| Edict CLI | 讀取角色設定、檢查派工範圍、呼叫 Orca、保存索引與收據 |
| Orca | 管理原生 Task 相依、Dispatch、代理生命週期與完成通知 |

角色限制及核准結論部分依賴代理遵守指令，並非作業系統權限隔離。派工範圍檢查用於避免讀寫衝突，不提供檔案存取沙箱；實際權限仍由各代理與執行環境設定決定。

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

使用固定 tag 更新前，先完成已派工作並保留本機修改。切換版本會同時改變所有指向此套件目錄的技能連結內容。

以下在套件目錄操作；`git status --short` 有輸出時先處理本機修改，不直接切換。將版本號換成要安裝的已發佈版本：

```sh
git status --short
git fetch origin --tags
git switch --detach v0.3.0-beta.1
node scripts/install-local.mjs --dry-run
node scripts/install-local.mjs
node bin/edict.mjs --version
```

舊副本若與遠端歷史不同，不使用 pull、merge 或強制重設來混合歷史。先保留本機修改，將指定版本 clone 到另一個目錄；依「移除安裝」確認並移除舊安裝的連結，再從新目錄安裝。安裝器會拒絕覆寫指向別處的既有連結。換裝期間保留舊目錄，對話狀態留在使用者目錄，不需刪除。

安裝連結指向本機儲存庫，不必向各工作專案複製技能。0.1 版專案檔案不自動刪除或覆寫，僅限在本對話首次 init 前，由代理依使用者要求用 `init --yes --session <ID> --import-config <舊config.json>` 匯入設定。已有設定的對話改用 `edict config set <角色> --session <ID> ...` 逐角色調整，不能再次匯入覆寫。舊版同名專案技能可能仍被讀取，升級時應先備份並停用，避免入口混用。本版不擅自刪除專案檔案。

每台電腦各自登入代理；GitHub 分享程式，不分享對話狀態或憑證。

## 移除安裝

先在使用中的對話執行 `/edict off`（Codex 為 `$edict off`），並確認已派工作已結束；off 本身不取消工作。以下為 macOS／Linux 的預設安裝位置，確認是指向本套件的符號連結後，只移除連結本身，不刪除整個技能資料夾：

- `~/.local/bin/edict`：指向本套件的 `bin/edict.mjs`。
- `~/.agents/skills/edict`：指向本套件的 `skills/edict`。
- `~/.claude/skills/edict`：指向上述共用技能；有設定 CLAUDE_CONFIG_DIR／ORCA_CLAUDE_CONFIG_DIR 時以實際位置為準。
- `~/.cursor/skills/edict`：指向上述共用技能。

自訂 `--bin-dir` 或 `--user-home` 時依原安裝位置處理。其他檔案、一般資料夾或指向其他套件的連結須保留。`~/.config/edict`（或自訂 EDICT_HOME）包含對話狀態與收據，移除指令及技能連結時保留；如需清除，先確認沒有未完成工作並另行備份。Windows 安裝與移除尚未驗證，不直接套用上述連結操作。

## 驗證

```sh
npm ci --ignore-scripts
npm test
npm run check
```

CI 在 push 到 main 與對 main 的 pull request 執行上述檢查，只有 contents:read 權限，不使用真實代理或帳號憑證。測試包含對話隔離、開關、設定與模型參數、失敗不重派、相依與衝突排程、版本查詢、相容性檢查，以及安裝不修改代理設定。模擬 Orca 不能證明供應商接受特定模型；技能指令不能代替各代理多輪對話與壓縮後的實測。

角色來源與適用範圍見 [NOTICE.md](NOTICE.md)。

## 狀態鎖檔與收據恢復

寫入狀態時，鎖檔記錄本機程序 PID、建立時間及主機名稱。同主機的持有程序已不存在時，下一次 init、config 或 off 會清除殘留鎖後重試；空白或無有效資訊的舊鎖需超過 30 秒才處理，讓新鎖有時間寫入資訊。程序仍存在、主機不同或無法確認時不依鎖齡強制清除，最多等待 500 毫秒後回報鎖檔路徑。可先確認持有程序是否仍在寫入；不要直接刪除活躍鎖。此恢復機制尚未驗證跨主機共用狀態目錄的情形。

派工收到 Orca 回應但狀態寫入失敗時，CLI 仍輸出原始收據，並嘗試另存到 EDICT_HOME/receipts（預設 ~/.config/edict/receipts），stderr 顯示檔案路徑。協調者應保存收據、向 Orca 核對 Run／Task／Dispatch，待狀態可寫後補記；不能重新派出同一工作。若備份也因磁碟或權限失敗，須保存 stdout 的原始收據，不能只依 status 缺少紀錄判定派工未發生。
