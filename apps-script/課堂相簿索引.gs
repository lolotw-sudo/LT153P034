/**
 * 客網新進人員訓練班第034期 — 課堂相簿索引
 * ============================================================
 * 把 Google Drive 照片資料夾的內容，定時寫進試算表的「課堂相簿」分頁，
 * 網站再從那個分頁把照片掛到賽季日誌對應的那一天。
 *
 * 【為什麼要繞這一圈，不讓網站直接讀 Drive】
 *   網站是純靜態的，沒有後端可以拿 Drive 憑證；而且「哪一天、幾點拍的」
 *   要讀 EXIF 才知道 —— Drive 記的建立時間是「上傳時間」，
 *   照片常常隔好幾天才上傳，用上傳時間會全部掛到同一天。
 *   拍攝時間還決定照片掛在哪一堂課底下（比對「課程表」分頁的時間欄）。
 *   所以由這支腳本定時把 EXIF 拍攝日整理進試算表，網站只讀試算表（穩且快）。
 *
 * 【設定步驟】
 *   1. 打開班級試算表 → 擴充功能 → Apps Script
 *   2. 左側「檔案」按 + → 指令碼，貼上本檔內容
 *   3. 左側「服務」按 + → 選「Drive API」→ 新增
 *      （要讀 EXIF 拍攝時間，一定要開這個進階服務）
 *   4. 把下面 FOLDER_ID 換成你的照片資料夾 ID：
 *      資料夾網址 https://drive.google.com/drive/folders/【這一段就是 ID】
 *   5. 上方函式選 setupAlbumTrigger → 執行（授權一次），
 *      之後每小時會自動同步一次
 *   6. 想立刻同步：函式選 syncAlbum → 執行
 *
 * 【資料夾權限】
 *   共用設定要是「知道連結的任何人 → 檢視者」。
 *   給「編輯者」的話，拿到連結的人可以刪掉全班照片。
 */

const ALBUM_CONFIG = {
  FOLDER_ID: '1fxUjI6Mre3hM_i7m8FQIXxZAWcvFHcTz',   // ← 換成你的照片資料夾 ID
  TAB: '課堂相簿',
  TZ: 'Asia/Taipei',
};

const ALBUM_HEADER = ['日期', '時間', '檔案ID', '檔名'];


/** 把資料夾裡的照片索引寫進「課堂相簿」分頁。時間觸發器呼叫的就是這支。 */
function syncAlbum() {
  const rows = listPhotos_();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(ALBUM_CONFIG.TAB) || ss.insertSheet(ALBUM_CONFIG.TAB);

  // 整片重寫：照片會被刪、被補，用累加的話刪掉的那張永遠留在表上
  sh.clear();
  sh.getRange(1, 1, 1, ALBUM_HEADER.length).setValues([ALBUM_HEADER]);
  if (rows.length) sh.getRange(2, 1, rows.length, ALBUM_HEADER.length).setValues(rows);

  Logger.log('已索引 %s 張照片', rows.length);
  return rows.length;
}


/**
 * 列出資料夾裡的圖片，回傳 [日期, 時間, 檔案ID, 檔名]。
 * 日期與時間優先取 EXIF 拍攝時間，沒有 EXIF（例如截圖、掃描檔）才退回上傳時間。
 * 時間是網站用來判斷「這張是哪一堂課拍的」的依據，退回上傳時間時會不準，
 * 所以那種情況只寫日期、時間留空 —— 寧可歸不到課，也不要歸錯課。
 */
function listPhotos_() {
  const out = [];
  let pageToken = null;

  do {
    const res = Drive.Files.list({
      q: "'" + ALBUM_CONFIG.FOLDER_ID + "' in parents and trashed = false " +
         "and mimeType contains 'image/'",
      fields: 'nextPageToken, files(id, name, createdTime, imageMediaMetadata(time))',
      pageSize: 200,
      pageToken: pageToken,
    });

    (res.files || []).forEach(f => {
      const meta = f.imageMediaMetadata || {};
      // EXIF 是 "2026:08:14 16:36:59"，createdTime 是 "2026-08-17T07:23:17.619Z"
      const exif = meta.time || '';
      const stamp = exif || String(f.createdTime).replace(/-/g, ':');
      const parts = stamp.slice(0, 10).split(':');
      if (parts.length < 3) return;

      out.push({
        sort: stamp,
        row: [
          Number(parts[1]) + '/' + Number(parts[2]),
          exif ? exif.slice(11, 16) : '',   // "16:36"；沒 EXIF 就留空
          f.id,
          f.name,
        ],
      });
    });

    pageToken = res.nextPageToken;
  } while (pageToken);

  out.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
  return out.map(o => o.row);
}


/** 執行一次就好：建立每小時自動同步的觸發器（會先清掉舊的，不會重複疊加） */
function setupAlbumTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncAlbum')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('syncAlbum').timeBased().everyHours(1).create();

  const n = syncAlbum();   // 順手跑一次，馬上看得到結果
  Logger.log('已設定每小時自動同步；這次索引了 %s 張照片', n);
}
