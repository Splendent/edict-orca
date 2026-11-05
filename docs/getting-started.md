# 首次使用 Edict for Orca

Edict 將工作拆分、派工與驗收保存在目前對話。安裝技能只建立入口，完成 init 後才啟用。

## 環境與安裝

需要 Node.js 20 以上、Git、可連線的 Orca，以及已登入的 Claude Code、Codex 或 Cursor。原生完整流程目前只在 macOS、Orca 1.4.249 與 Codex 的有界報告任務驗證；[支援範圍](../README.md#支援與驗證範圍)列出其他限制。

1. 在獨立目錄取得發布版。

   ```sh
   git clone --branch v0.4.0-beta.4 https://github.com/Splendent/edict-orca.git
   cd edict-orca
   ```

   指定 tag 會進入 detached HEAD，供固定版本安裝使用。開發貢獻請改依 [貢獻指南](../CONTRIBUTING.md) 建立分支。

2. 檢查安裝計畫，確認沒有與既有技能衝突。

   ```sh
   node scripts/install-local.mjs --dry-run
   ```

3. 建立技能與 CLI 連結。

   ```sh
   node scripts/install-local.mjs
   node bin/edict.mjs --version
   ```

   預期顯示 `edict-orca 0.4.0-beta.4`。連結指向此原始碼目錄，安裝後須保留它。若 `edict` 不在 PATH，可直接使用 `node /絕對路徑/edict-orca/bin/edict.mjs`。

4. 在 Orca **Settings → Orchestration → Nested worker depth** 確認深度至少為 `3`。
5. 回到要工作的對話，依下節手動啟用。

安裝不修改登入憑證、模型或代理 hook，也不啟用其他對話。Windows 的安裝及移除尚未完整驗收，不直接套用上述 POSIX 環境假設。

## 在聊天中啟用

Claude Code／Cursor 輸入 `/edict init`；Codex 輸入 `$edict init`。

代理會詢問各角色共用哪種代理，以及模型使用工具預設或指定 ID。可直接回答：

```text
各角色先共用 Codex，模型沿用工具預設。
```

這只是回答範例，並非 Edict 自動選定的設定。想分開設定時，可描述具體角色與模型，例如要求兵部使用已確認可用的模型 ID；不需要先手寫整份 JSON。

聊天互動由目前代理收集選項，再保存已確認的值。非互動 shell 沒有 TTY 選單，代理不應直接執行等待輸入的裸 `edict init`。終端機互動初始化則是文字問答。

設定完成後輸入 `/edict status` 或 `$edict status`。預期目前對話為 active=true，且角色設定符合剛才的選擇；Cursor 還有下節的模式確認。

## Cursor 模式確認

Cursor 作為協調者時，首次 init 會保留 pending=cursor-custom-mode。請在 Cursor 原生技能選單選 **Use as Mode**，確認輸入框出現模式標記，再告知目前代理完成確認。確認成立後才會啟用；介面沒有此選項時保持 pending，不宣稱已啟用。

Cursor 僅作為被派工的執行代理時，不需要這個協調者模式步驟。

## 交代多項工作

```text
修正登入錯誤，更新使用文件，確認安裝步驟。
每項工作各自列出成果與驗證結果，需要發布時先交給我確認。
```

原對話整理需求，中書拆分可驗收的工作，門下審查方案；尚書依核可範圍交給相關部門。部門頭領管理執行代理並核對回報，刑部獨立驗收，門下確認結案。

一般問答仍可直接回答。提出工作不會讓未啟用的其他對話自動啟用。執行中可以要求查詢狀態、暫停指定工作或取消；取消完成須有原生程序停止或結束的證據。

## 從舊版開始使用 v2

v1 session、config 與工作資料不能由 v2 讀取，也不會自動轉換。使用新版前，先在舊環境確認原生工作已結束並停用原對話；保留原資料。

新版須使用全新的 EDICT_HOME，並把同一絕對路徑交給原對話及所有下屬。以下是 POSIX shell 的環境設定範例，應在啟動代理工具前設定，或由代理在每次 Edict CLI 呼叫使用同一值：

```sh
export EDICT_HOME="$HOME/.config/edict-v2"
```

請先確認此位置沒有舊資料。設定環境變數不會修改已執行的其他代理程序環境；原對話需記住並持續傳遞它。接著在新對話重新選擇設定並手動 init。原本的 v1 對話不在新版 CLI 繼續工作。

## 資料位置與對話身分

預設資料目錄是 `~/.config/edict`，可用 EDICT_HOME 指定。對話狀態放在 `sessions/`，工作流程資料放在 `workflow.json`。資料可能包含任務、路徑、模型設定與成果證據，請勿公開整份目錄。

CLI 使用明確的 `--session`、EDICT_SESSION_ID 或 CODEX_THREAD_ID 識別對話；缺少原生 ID 時首次 init 會回傳 `conversation:UUID`。目前代理須保存該 ID，不能用專案路徑、終端機或最新檔案猜測。壓縮摘要須保留 EDICT_HOME、session、設定、Run 與未完成操作。

## 更新、停用與移除

在原對話要求 `/edict update`，Codex 使用 `$edict update`。更新器只選已發布且適用的版本；預覽版可更新至較新的預覽版或正式版，正式版不自動切換至預覽版。若版本跨越資料格式，依發布說明使用新狀態，不延續不支援的舊資料。

更新要求安裝為獨立 Git clone、origin 符合官方來源且工作目錄乾淨。它會改變共用安裝的後續 CLI；先確認其他對話沒有依賴舊版的在途工作。當前代理重讀指引後才算完成對話重讀，其他對話不會自動重讀。

`/edict off` 或 `$edict off` 關閉目前對話的新派工，不自動取消既有代理。移除前仍須核對原生工作已結束，再依 [更新與移除](../README.md#更新與移除) 檢查連結。不要刪除未核對的技能或 EDICT_HOME 資料。

需要協助請讀 [故障排除](troubleshooting.md)，或使用 [問題回報](https://github.com/Splendent/edict-orca/issues/new/choose)。
