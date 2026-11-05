# 派工、訊息、控制與恢復

本文件適用已啟用的 v2 工作。命令必須明確帶原 session、原生 Run 及同一 EDICT_HOME。舊 dispatch、task-create、dispatch-ready、continue 入口明確拒絕；不以它們繞過核可或控制。角色與完整 JSON 見 [工作契約](workflow.md)。

## 啟動與資源

root 先用 run open 建立 Run，再以無 work 的 team ensure 建立中書、門下、尚書三個平行頭領。門下與尚書先沒有業務 scope；中書保存 plan 後 grant 門下，門下核可後 grant 尚書。grant 既有頭領不另開原生 helper；另以 team send 交接。缺少原 root 空頭領時應 ask root，不由中書巢狀建立尚書。

原生深度至少 3：root 到三省頭領為第 1 層，尚書到部尚書為第 2 層，部尚書到郎中為第 3 層。使用者在 Settings → Orchestration → Nested worker depth 確認。Edict 不自行修改 App 設定；深度不足、額度不足或能力不支援時，保留真實錯誤與操作，不增加深度、重開 Run 或換供應商繞過。

頭領只能建立有權管理的角色。六部頭領管理本部 executor，executor 不得再派工。指定 work 的 ensure、delegate 與 team send 均在 JSON 帶目前 generation。所有實作及業務續辦需有效核可，委派 reads／writes／resources 不能超過需求及方案。方案 dependencies 是其他工作項目 ID，未 Done 前不得啟動依賴它的工作。

目前共用 EDICT_HOME 的工作紀錄對在途成員計算名額，最多 3 位 executor、16 位在途成員；這不是整台主機、其他 EDICT_HOME 或繞過 Edict 的原生硬上限。收到事件後單次 sync 更新原生事實，避免已結束操作仍占額度。沒有背景排程器會自動重跑被拒絕的派工；由頭領在相應事件到達後重新核對准入，不重送結果未知的操作。

同工作樹互不衝突的讀寫可並行；讀與寫、寫與寫重疊或工具互斥需等待。未知範圍保守限制。範圍檢查涵蓋實體路徑、目錄與連結，不是 OS 存取沙箱；不得藉更換連結越出授權。

## 工作樹

派工 worktree 放在 JSON，不是 delegate 的 shell flag。

| worktree | 使用方式 | 條件 |
| --- | --- | --- |
| current | 預設，沿用呼叫者原生工作樹 | 單一專案基準可核對；不衝突才並行 |
| new-child | 由 Orca 建立子工作樹 | 真正需要隔離時使用；原生支援仍須確認 |
| path:/絕對路徑 | 已存在的工作樹 | 已取得授權且可核對前置成果與實際位置 |

本入口不提供 new-top-level、repo、base-branch 或獨立的 Task DAG 編輯。不可照舊 CLI 範例傳這些旗標，也不為隔離擅自 git init 或建立頂層工作樹。新工作樹未必包含未 commit 成果，須提供可核對基準；本實作成果索引以 Run 專案及操作成果目錄核對，跨工作樹交付未全測。需要隔離時先確認其實際交付路徑能符合此限制，不把不支援情境宣稱可用。

## 正式訊息與 owner 轉交

具體工作訊息由有權頭領傳送，使用目標邏輯 member ID，不使用其 Dispatch 代替成員 ID。JSON 例如：

```json
{"generation":1,"kind":"handoff","body":"請核對 W-001 目前成果版本與未解問題，保留原方案及驗收證據。"}
```

```sh
edict team send "$TARGET_MEMBER_ID" --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --work W-001 --spec-file /tmp/edict-message.json
```

三省按合法職權交涉；六部只與尚書交涉，各部不得直接指揮其他部門。executor 依原生 ask／worker_done 向直接頭領報告，不能以 team send 冒充頭領。`team send` 不切模型，已 settled executor 的明確續辦必須回到原工作與同一方案世代，重新取得原範圍及資源；不向正在執行或仍未知的 executor 追加未追蹤實作。

kind 只接受 handoff 或 report，省略時是 handoff。handoff 受 active、Done、pause、cancel、核可及資源檢查。完成通知或停止結果應另寫 `/tmp/edict-report.json`：

```json
{"generation":1,"kind":"report","body":"W-001 的已確認結果及剩餘在途操作見目前 work show；只回報事實，不要求恢復業務。"}
```

```sh
edict team send "$TARGET_HEAD_MEMBER_ID" --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --work W-001 --spec-file /tmp/edict-report.json
```

report 只許頭領送既有頭領，仍核對真實身分、角色路由、共同 scope 與 generation，不能送 executor。它可以在 Done、pause、cancel 或 off 後保存並轉達唯讀結果，不清除控制、不授權新派工、不改方案或驗收。接收者不得把 report 內的要求當成可執行業務；需要新增或恢復工作時仍須走原控制、世代及核可流程。report 也會保存原生傳送收據；沒有結果時不宣稱送達。

若目標 settled peer 受原生 owner／lineage 限制，send 回應 state=owner-required 及 Edict messageId。原對話只原樣轉交：

```sh
edict team forward "$EDICT_MESSAGE_ID" --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID"
```

forward 不帶任意 body，不讓 root 重做審查或擴大內容；保留原訊息 kind，不能把 handoff 換成 report 繞過控制。原訊息與代送操作的 ID、原發起者、目標、工作世代及結果保留。不要在 consumer_fenced 後直接改用裸原生 send，避免繞過業務與資源檢查。

## 狀態、結果未知與恢復

```sh
edict work show --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID"
edict sync --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID"
edict recover --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --operation "$EDICT_OPERATION_ID"
```

work show 讀協作資料；sync 查原生 worker 事實、保存已結束與停止結果並回傳工作視圖。它們都不代表方案自動通過。session status 的舊 Task／Dispatch 索引不是新工作引擎的完整操作清單，應查 workflows 及 work show。

啟動前持久保存操作、原生 request ID、身分、設定與資源；接受後保存原生 Task／Dispatch／Run 收據。已送出後沒有回應或保存失敗時，不因看不到索引而新開 Task、Run 或重派。recover 只能由原操作發起者身分核對同一 request ID，不會自動重送。不要自行操作 --retry-request 或以新 UUID 代替未知操作。

缺少、錯誤型別或跨 Run 的收據保留為未知，不用 messageId 掩蓋壞掉的 Task／Dispatch 欄位。原生 pending 可能已有副作用；absent 或收據保留期到期也不證明沒發生。不能恢復身分或查清結果時保留占用並回報，載入本機 recovery-and-cleanup 指南處理。

只有原生明確確認 effectsApplied=false 的拒絕，才能列為沒有原生副作用；不要把任何 failed 當作未啟動。取消後晚到接受收據仍入清冊，繼續必要停止核對，不清除取消或開始下一階段。重試與修正最多三次仍失敗時停止自動修正，說明待驗證假設，不透過新世代重設原生熔斷。

## 使用者控制

root 依使用者明確對象操作；省部頭領或 executor 不代替 root 改控制。work 可省略以控制整個 Run：

```sh
edict control pause --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --work W-001
edict control resume --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --work W-001
edict control cancel --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --work W-001
```

pause 關閉後續准入；已持久送出的請求仍可能稍後實體啟動，列為在途，不能承諾所有程序凍結。resume 只解除指定 pause，不解除上層 Run pause、off 或取消。off 以對話為範圍關閉新派工及業務推進，不取消現有原生程序；原成果與收據仍可保存。再次 init 不解除 pause 或取消。

cancel 持久撤回該工作世代的業務授權，禁止新派工、業務續辦、驗收推進與 Done；保存收據與成果並處理受控停止。starting、排隊輸入、Keep open 或停止結果未知時，仍有收尾工作。取消已受理不等於取消已完成；取消不回復已修改檔案、不撤銷外部效果，也不因共用頭領程序而停止其他項目。

取消後的晚到成果只歸檔，不再成為有效交付。確認原 executor 與未知訊息已收斂後，使用者明確要求重做才能由 root 執行：

```sh
edict control restart --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --work W-001
```

restart 保留工作 ID，增加 generation、清除目前方案與成果並保留舊歷史；須重寫方案、重審與重新授權，不能直接沿用舊代核可。Run 層取消不能用項目 restart 清除。已合法結案後的取消不改寫 Done 歷史。

不輪詢、不依固定延遲重試。收到原生事件或使用者指令時單次核對即可；無輸出與喚醒延後不構成停止證據。支援限制與未完成原生驗收應隨結果回報。
