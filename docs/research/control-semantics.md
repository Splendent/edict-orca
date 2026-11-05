# Edict 控制語義研究

研究日期：2026-11-05。對象為本機 Edict 0.3.0-beta.2 與 Orca 1.4.249。結論：省部內多代理架構有原生 helper 支援，但必須適配其 owner、請求收據及控制邊界；本機鎖不能保證原生接收與實體啟動同步取消。相容與遷移安排不在本方案範圍。

本研究包含原始碼閱讀、官方資料、實際問題紀錄及抽象模型。沒有派出真實代理、建立 Run、取消工作、操作現有安裝或測試平台執行能力。以下將靜態事實、設計選擇與待驗證契約分開。

## 1. 本機原生能力

### 1.1 派工與回報

本機原生程式證據位於 `/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/main/chunks/orcad-migration-source-retention-DzB-8KLK.js`。這是壓縮後程式，其行號按安裝版本記錄；函式名稱與行號不可當跨版本 API。

| 證據 | 可確認的靜態行為 | 設計後果 |
| --- | --- | --- |
| 第 692 行 Bnt，以及第 687 行 xG | active worker 可在自己的 Run 建立 helper；不能任意改 Run | 頭領可分工，但不是新的任意 Run 協調者 |
| 第 671 行 N7e、第 2693 行 Adt | --spec 建立 Task 與 Dispatch，可傳 deps／parent，未指定 parent 採 creator 的 Task；原生啟動要求 ready | 未就緒工作先是 Edict 意圖；不可假稱已建立原生 pending |
| 第 2804 行 taskCreate、第 395 行 JR、第 692 行 CG | task-create 需要合法 Run owner；worker 啟動既有 Task 另受 creator lineage 限制 | 不可把主對話的 task-create → worker-start --task 原樣交給頭領 |
| 第 687 行 Utt／Wtt／QW、第 2795 至 2796 行 send | 直接 creator active 時接收子代理回報；creator settled 時回落 root；settled peer 的續辦受 owner／lineage 檢查 | active peer 可交涉；settled peer 由合法 owner 代喚醒，業務來源不變 |

inbox 可讀性不能證明業務權限。正式核可與結案仍由 Edict 角色政策檢查，不能把普通 status 訊息當作已核可。

### 1.2 原生請求身分與收據

`out/cli/runtime/client.js` 第 54 至 62 行，durable mutation 在送出前選擇 `orchestrationRequestId` 或新 UUID。`out/cli/handlers/orchestration/mutation-request.js` 第 10 至 25 行將 retry-request 傳入原生請求身分。

原生 chunk 第 1317 行 Vct，以 caller fingerprint 與 request ID 查重並核對 method／payload hash；第 2693 行 Adt 將 worker-start 的 mutation receipt、Task、Dispatch 及 starting 記錄置於同一 SQLite 交易，收據可包含 accepted Task／Dispatch。第 696 行 requestShow 可回 completed、pending、absent；pending 可能已產生副作用，absent 不代表沒有發生。收據依期限及容量清除，不是永久去重。

設計必須把本機 operation ID 與原生 request ID 連結。相同意圖恢復使用相同原生 ID、參數及可恢復的呼叫身分，不能換 ID 重送。首次 UUID 必須在外部副作用前持久保存；雖然原始碼存在自訂 ID 通路，公開 retry-request 說明定位為既有請求恢復，首次使用及跨重啟身分仍須取得明確適配契約並實測。若版本不提供可靠介面，先補原生準備請求能力，不用私有假設繞過。

### 1.3 停止與放棄

原生 chunk 第 2680 行 ldt 的一般停止入口接受 ready、start_unknown 或特定 stopping 恢復；starting 會拒絕。hdt 的 abandon 可終結派工能力，但不證明資源或程序已退出。第 687 行 wnt 對 queued chat 的回應也明示，abandon 不會移除已排入的聊天卡片。

worker-start 請求契約沒有工作項目取消 epoch。未查到可用於「撤回所有尚未接受的請求」或「接受前與 Edict 控制 revision 一起裁決」的公開原生契約。因此不能宣稱本機檔案鎖能阻止所有稍後實體啟動。

## 2. 控制語義

### 2.1 四種不同資料

| 資料 | 決定的事情 | 不能代表的事情 |
| --- | --- | --- |
| 控制要求與授權世代 | 允許哪些工作繼續推進 | 所有程序已停止 |
| 原生請求與 Dispatch 收據 | 是否接受、實際委派身分及執行事實 | 業務驗收或結案通過 |
| 成果與驗收決定 | 該版本成果是否可接受 | 可以忽略取消或 off |
| 結案確認 | 合法版本的整體工作可否 Done | 撤回已發生的檔案或外部效果 |

取消立即撤回該代業務授權，但實際收尾可能需要時間。Temporal 官方區分 TRY_CANCEL、WAIT_CANCELLATION_COMPLETED、ABANDON；取消要求送達後活動仍可能繼續執行。[Temporal TypeScript 取消說明](https://github.com/temporalio/documentation/blob/main/docs/develop/typescript/workflows/cancellation.mdx)

Kubernetes finalizers 同樣區分刪除要求與清理完成；本方案只採用此語義區分，不引入 Kubernetes 或其控制器。[Kubernetes finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/)

### 2.2 各種操作

pause 關閉新准入，保留已提交及執行工作；resume 只解除指定 pause，不清除 Run pause、off 或取消。off 保持原有對話停用語義，不自動取消原生程序。

cancel 在工作項目的 workGeneration 記錄不可逆意圖，拒絕該代新業務委派、重試、驗收推進與 Done。收據、成果、停止證據及必要收尾仍可保存。原生晚到 success 如實保留，不能清除取消或觸發後續工作。

取消完成從清冊計算：沒有未確認的送出、仍可能執行的委派、未知副作用或仍可能寫入的資源占用。已留下且已查清的修改列入結果，不自動回復。重新授權採同項目的新 workGeneration；保留舊代歷史，新代重新核對方案、證據與原生重試限制。

同一頭領服務多個項目時，按委派及項目世代取消，不按整個頭領程序取消。若原生不能只停止其中一項，顯示限制與未完成清冊，不能犧牲其他項目來冒充單項取消完成。

Temporal Python issue #700 提供取消顯示與活動之後完成的實際討論；這是該系統的歷史證據，不能據此聲稱 Orca 有同一錯誤。[問題紀錄](https://github.com/temporalio/sdk-python/issues/700)

### 2.3 決策順序

1. 保存及去重原生事實，即使已 off、暫停或取消也保存。
2. 依本機持久提交序號核對 session、Run、項目控制，不使用不同代理時鐘裁決競態。
3. 核對工作世代、頭領世代、方案、成果及真正身分；舊世代僅供歷史查閱。
4. 接受相應核可、驗收或結案決定；被控制阻擋時只保存待核對。
5. 提交派工或 Done 前再次在相同序列化邊界核對。合法 Done 已先提交時，不由之後的取消改寫歷史。

取消必要項目不會偷偷把它從整體需求刪除。使用者縮小需求時，記錄新的需求／方案版本，門下確認新的覆蓋範圍。

## 3. 本機提交與原生接受的界線

以下反例足以否定「只要再讀一次 active 或加短鎖就沒有競態」：

```text
A 預留名額
A 在短鎖內登記送出
B 提交 pause，回覆使用者
A 實際呼叫 Orca
```

本機檔案與 Orca 是兩個提交系統。AWS outbox 資料處理的是本地業務資料與待送事件共同保存，仍要求接收端處理重送；它不提供跨任意原生呼叫的單一原子交易。[AWS transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)

本設計選擇可實作的承諾：本機持久送出提交為在途起點，控制在同一短鎖內關閉後續准入；在途不等於已實際啟動。先控制就拒絕新的送出提交；先提交則顯示在途及其原生核對結果。請求可能稍後抵達，不能承諾控制回覆後沒有新的實體程序。

如果要求更強的「此刻之後不得出現任何新實體啟動」，須由原生接收／輸入端提供控制 epoch 或可撤回請求，共同檢查原生接受。不能在沒有這項能力時悄悄改回「鎖外呼叫」卻維持強承諾。

回應遺失不代表操作沒發生。恢復需接上原生 request ID 與持久收據；同 ID 不同參數應拒絕，超過原生收據保留期或無法恢復身分時保留未知。此原則有 AWS 的請求識別與晚到要求分析支持；不據此假設 Orca 有無限保留期或自動去重能力。[AWS 安全重試](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)

## 4. 抽象模型與驗證界線

執行方式：

```sh
python3 docs/research/control_model.py
```

模型枚舉 reserve、admit、send、receipt、control、crash，在保持四項送出步驟順序下，分別插入 pause、off、cancel，共 90 種交錯。它只建模一個操作的准入、送出、不確定回應與接受收據；不建模多項隔離、世代轉換、resume 或門下結案。輸出中的 PASS 僅表示明列斷言成立，不能用固定資料示例替代未實作的事件轉移。

模型保留並輸出「admit → control → send」反例。因此它沒有證明嚴格停止所有實體啟動；相反地，它確認較強承諾不能由此模型推出。它假定本機原子序列化及持久記錄，沒有測磁碟故障、IPC、真實 request ID、原生停止、代理身分、程序與各供應商的執行行為。

receipt 明確代表原生接受收據，不是工作結束。取得收據後請求結果已知，但仍可能有執行及副作用；此模型沒有停止證據，凡已准入的操作都不能據此推導取消完成。已實際執行 reserve → admit → send → control → receipt 的回歸情境，確認收據保存且取消完成仍為 false；另以真實模型轉移測重複 send 及 unknown 恢復不發出第二次呼叫。這是客戶端規則，不是接收端去重的執行證明。

真實驗收採主設計 D-01 至 D-05 的同步點測試。尤其必須在本機送出提交後、原生接受前中斷，再恢復同一原生操作；只比對最終 paused 欄位不算成功。

## 5. 待驗證與發布條件

| 必須驗證 | 未通過時允許的結論 |
| --- | --- |
| 首次原生 request ID 事先持久保存、恢復同一身分及收據 | 可保留設計；不得宣稱不重派恢復已可用 |
| helper 直接頭領回報、settled peer owner 代喚醒、未就緒 deps 無半份 Task | 不啟用階層模式；先修適配契約 |
| starting／ready／queued／unknown 的停止及收尾 | 只回報已關閉新准入及待收斂清冊，不宣稱全部已停止 |
| 門下結案、刑部獨立驗收及原控制矩陣 | 不得以更快或代理自行回報成功取代制度性驗收 |

本研究不引入 Temporal、Kubernetes 或常駐 outbox relay。官方資料用來界定控制語義與保證，本地 source 用來選擇 Orca 適配；真正功能可用仍須實作及原生執行驗收。

## 6. 獨立審查與驗證紀錄

2026-11-05，由三位未參與原設計撰寫的代理分別核對原版核心及控制、原生適配與恢復、交付完整性；研究建議由文件作者整合，原審查者再核對修訂內容。

| 範圍 | 複審結果 | 驗證界線 |
| --- | --- | --- |
| 主控制設計及原版核心 | PASS | 保留分權、門下結案與刑部責任；取消世代及在途控制契約一致 |
| 原生適配與恢復描述 | PASS | 與已閱讀的 Orca 1.4.249 靜態程式一致；原生執行、停止及去重未實測 |
| 單操作研究模型 | PASS | 90 種抽象交錯，以及接受收據不等於取消完成、重複 send、unknown 恢復的具體轉移 |

模型審查發現的收據語義與過度宣稱已修正，兩位原審查者重新執行後確認通過。此紀錄不等於主設計 G-01 至 G-05 或 D-01 至 D-05 已通過；實作與原生功能發布仍須完成它們。
