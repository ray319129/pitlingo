# PitLingo 開源版 隱私權說明

最後更新：2026 年 11 月 8 日

PitLingo 開源版是一個在你的瀏覽器裡執行的擴充功能，**沒有任何 PitLingo 伺服器，開發者收不到任何資料**。

## 存在你瀏覽器裡的東西

存在 `chrome.storage.local`（只在這台電腦、不跨裝置同步）：

- 你的 Anthropic API key 與模型名稱
- 顯示設定（字級、顏色、位置等）
- 譯文快取：最近 20 支 F1TV 影片的英文字幕與中文譯文
- 當天的 token 用量統計

在設定頁按「清除金鑰」「清除本機譯文快取」，或移除擴充功能，就會刪除。

## 會連線到哪裡

| 對象 | 送出什麼 | 為什麼 |
|---|---|---|
| F1TV（`*.formula1.com`、`f1prodlive.akamaized.net`） | 一般的串流請求（帶你在 F1TV 的登入 cookie） | 讀取字幕清單與字幕檔 |
| Anthropic（`api.anthropic.com`） | 你的 API key、要翻譯的英文字幕 | 翻譯。Anthropic 如何處理這些資料見 [Anthropic 的隱私權政策](https://www.anthropic.com/legal/privacy) |

除此之外不連線到任何地方，沒有分析、沒有追蹤、沒有廣告。

## 聯絡

到 GitHub 開 issue：https://github.com/ray319129/pitlingo/issues
