# Edict for Orca

在現有 Orca 對話使用三省六部的規劃、審核、派工與驗收流程。Claude、Codex、Cursor 可按角色指定模型。Node.js 20 以上，沒有 npm 執行依賴。

## 在其他電腦安裝

前置條件：Node.js 20 以上、Git、已登入且可用的 Orca，以及所選代理的登入狀態。私人儲存庫需要有權限的 GitHub 帳號；以下使用已登入的 GitHub CLI。

```sh
gh repo clone Splendent/edict-orca
cd edict-orca
node scripts/install-local.mjs
```

安裝器將 `edict` 放在目前使用者的 `~/.local/bin`，若該目錄尚未加入 PATH，會顯示需要加入的目錄。每台電腦各安裝一次；不會同步或複製帳號憑證。

Windows 安裝器產生 `edict.cmd`，PowerShell 使用 `edict.cmd init`；Windows 及 Linux 的實際執行尚未驗證。也可直接使用 `node <儲存庫路徑>/bin/edict.mjs init`，不依賴 PATH。

## 初始化專案

在要使用 Edict 的專案根目錄執行：

```sh
edict init
```

依提示設定共用代理、模型與各角色設定；留白模型使用該工具預設。初始化不啟動代理、不改目前對話模型。設定寫入 `.edict/config.json`；技能安裝到 `.agents/skills/edict` 及 `.claude/skills/edict`。Cursor 也會讀取上述目錄。這些檔案可隨專案納入版本控制，讓新的工作樹取得相同技能與設定。

接著在目前對話說「用 Edict 處理這個需求」。若既有對話尚未發現新技能，說「讀取 .agents/skills/edict/SKILL.md，依 Edict 流程處理這個需求」，不需要另開對話。

## 角色設定

```sh
edict roles
edict config
edict config set menxia --agent codex --model MODEL_ID --effort high
edict config set bingbu --agent cursor --model MODEL_ID
edict config set menxia --clear-model
edict doctor
```

`MODEL_ID` 換成使用者選定、供應商實際接受的模型識別碼。Edict 不維護可能過期的模型清單，不自動換模型。`effort` 須搭配模型，接受值由 Orca 與實際代理驗證。切換代理會清除舊模型及推理強度；換模型會清除舊推理強度。設定只影響新 worker。太子通常由目前對話履行，設定不會改變目前對話模型。

`edict init --yes --agent codex` 可用於非互動初始化；所有角色先使用該工具預設模型，再用 `config set` 調整。再次初始化保留設定，只更新未經本機修改的 Edict 技能檔；遇到同名既有技能就停止，不覆寫。

## Orca 通訊

主對話協調者讀取本機 Orca 版本對應指南，建立 Run 後，依序派規劃、方案審查、派工、執行與成果驗收。worker 完成時由 Orca 喚醒原對話，協調者推進後續工作。Edict 不啟動伺服器、看板或常駐輪詢程序。

```sh
edict dispatch zhongshu --spec-file /tmp/edict-plan.txt --run RUN_ID --worktree current --dry-run
```

`--dry-run` 僅輸出參數與完整角色任務；移除後才實際派工。文字經 stdin 傳入 `worker-start --spec-file -`，不拼接 shell。派工保留目前工作目錄與 Orca 呼叫身分；`--project` 僅選擇設定來源。

可能同時修改檔案的任務交由 Orca 建立工作樹：

```sh
edict dispatch bingbu --spec-file /tmp/edict-build.txt --run RUN_ID --worktree new-top-level --repo id:REPO_ID --name edict-bingbu
```

`REPO_ID` 由 `orca repo list --json` 取得。Edict 不自行註冊專案或建立 git checkout。實際派工失敗或結果未知時不重試、不自動改設定；依 Orca 收據及復原指南處理。

Orca 入口依 `ORCA_CLI_COMMAND`、`ORCA_DEV_REPO_ROOT`、作業系統選擇；Linux 預設 `orca-ide`，不誤啟動 GNOME 螢幕閱讀器。`ORCA_CLI_COMMAND` 必須是單一執行檔名稱或路徑，不含 shell 參數。

## 驗證範圍

```sh
npm test
npm run check
```

測試使用隔離目錄及模擬 Orca，涵蓋設定、安裝衝突、參數轉交、shell 字面值及失敗不重試。`edict doctor` 檢查本機 Orca 狀態與參數；不能證明模型帳號可用或真實多代理任務已通過。完整實際派工測試需在 Orca 管理的專案、已登入代理與有效模型下執行。

來源、角色差異及範圍見 [NOTICE.md](NOTICE.md)。

## 更新其他電腦

在該電腦的 `edict-orca` 儲存庫執行：

```sh
git pull --rebase
node scripts/install-local.mjs
```

安裝連結指向本機儲存庫，更新後指令使用新版程式。在已初始化的工作專案內執行 `edict init --yes`，更新專案技能並保留各角色設定。若技能曾被手動修改，初始化會停止並指出衝突位置。

程式來源透過 GitHub 分享；各專案的 `.edict/config.json` 由該專案自行保存。不同電腦可使用不同模型設定，但都須在當地登入相關代理。
