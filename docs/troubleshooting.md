# 故障排除

依實際訊息選擇下列情況；結果未確認時保留原操作與收據，不重新派工測試。

| 現象 | 原因與處理 |
| --- | --- |
| 找不到 `edict` | `~/.local/bin` 可能不在 PATH。先以 `node /套件絕對路徑/bin/edict.mjs --version` 核對套件，再檢查 PATH |
| 技能沒有出現在對話選單 | 確認安裝連結及目前代理使用的技能目錄；可請代理直接讀取已安裝的 SKILL.md。安裝不代表對話已啟用 |
| 安裝顯示「已有其他技能／指令」 | 安裝目標已被不同內容占用。先檢查其來源與用途，不直接刪除或覆寫 |
| init 顯示「互動初始化需要終端機」 | 在非 TTY 環境執行互動初始化。改在聊天由代理詢問選項，再用已確認的值保存；`--yes` 不授權代理自行選模型 |
| Cursor 保持 pending | 尚未完成原生 Use as Mode 確認，或當地介面沒有該模式。依 [Cursor 模式確認](getting-started.md#cursor-模式確認) 核對 |

## 派工與身分

| 訊息或現象 | 處理 |
| --- | --- |
| Nested worker depth 不足 | 使用者在 Orca Settings → Orchestration 設定至少 3。保留原操作，核對確定沒有原生效果後才安排後續；不改設定檔繞過限制 |
| 無法辨識對話／尚未啟用 | 核對本對話保留的 session 與 EDICT_HOME，再查詢 status；失去 ID 時回報，不用其他對話的 ID 替代 |
| v2 格式不正確或舊版資料不支援 | 依 [新狀態說明](getting-started.md#從舊版開始使用-v2) 使用新位置；不把舊檔案的 version 手動改為 2 |
| 越權、缺少 scope、generation 過期或未核可 | 目前角色或工作契約不允許該操作。由相應頭領核對授權、目前世代及審查，不改成其他角色字串重試 |
| 資源已滿或範圍衝突 | 錯誤訊息列出衝突的工作 ID、角色／職位、operation ID 及衝突維度。核對仍在執行或結果未確認的代理、檔案範圍與工具資源；只因共用工具資源衝突時，改用不同資源名稱；需求的 resources 尚未授權該名稱時，才由 root 以 `work amend` 修訂；範圍過寬時改宣告較窄的 reads／writes；其餘等原生結束及同步後再決定，不繞過占用檢查 |

`doctor` 只檢查基本介面及執行環境，不會實際派工，也不能證明所有代理、模型或階層操作可用。

## 結果未確認、取消與恢復

若派工或訊息傳送顯示 unknown，請保留 Run、operation、request 與 Dispatch ID。由有權的原操作發起者使用 `recover` 核對同一請求，不另外建立相同任務。缺少證據時維持未確認。

原生 Task 成功與工作 Done 是不同紀錄。工作還需要有效實作成果、刑部 artifact-acceptance、門下 closure-confirmation；缺少其中一項應由對應角色核對，不手改完成狀態。

取消要求已保存不代表程序已結束。由原對話核對 `sync` 結果與原生停止收據；已送出的操作可能稍後才回傳，需要按原操作持續核對。

遇到鎖檔錯誤時先確認持有程序及主機，不直接刪除活躍鎖檔。未知操作仍可能占用資源，刪檔不會停止原生程序。

## 更新被拒絕

| 原因 | 處理 |
| --- | --- |
| 不在獨立 clone 根目錄 | 改用官方獨立 clone 安裝；來源壓縮檔或工作專案不能由更新器就地更新 |
| origin 不符 | 核對是否為預期來源；不要為了更新而把其他專案的 origin 改成 Edict |
| 有本機修改或未追蹤檔案 | 先保留並處理變更。更新器不會自動 stash、reset 或覆寫 |
| 更新鎖仍存在 | 核對是否還有更新程序；不直接刪鎖或重送 |
| 沒有較新適用版本 | 查閱 [Releases](https://github.com/Splendent/edict-orca/releases)；main 上的提交不一定已發布 |

## 回報時附哪些資訊

用 [錯誤回報範本](https://github.com/Splendent/edict-orca/issues/new?template=bug_report.yml) 提供套件、Node、Orca、作業系統及代理版本，並列出最小重現步驟、預期與實際結果。

一般錯誤只附必要日誌，將 token、密碼、私有路徑、對話內容與機密專案名稱換成 `<REDACTED>`。不要公開整份 workflow.json、session 或憑證設定。疑似安全漏洞依 [安全政策](../SECURITY.md) 私下處理。
