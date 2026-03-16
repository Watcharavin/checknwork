// ============================================================
//  GOOGLE APPS SCRIPT — REST API Backend (LINE Auth Edition)
//  วิธีใช้: Deploy > New deployment > Web App
//           Execute as: Me | Who has access: Anyone
//
//  ⚠️  ตั้งค่า Script Properties ก่อน Deploy:
//       Extensions > Apps Script > Project Settings > Script Properties
//
//       LINE_CHANNEL_ID   →  Channel ID จาก LINE Developers Console
//       ADMIN_USER_IDS    →  LINE userId ของ Admin คั่นด้วย comma
//                            เช่น  U1234abcd,U5678efgh
// ============================================================

// ─── Helpers ────────────────────────────────────────────────

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ป้องกัน Formula Injection ใน Google Sheets
// เซลล์ที่ขึ้นต้นด้วย = + - @ จะถูก prefix ด้วย '
function sanitize(val) {
  if (val === null || val === undefined) return '';
  const str = String(val).trim().substring(0, 300);
  return /^[=+\-@|%`]/.test(str) ? "'" + str : str;
}

// ─── LINE Auth ──────────────────────────────────────────────

function verifyLineToken(token) {
  if (!token || typeof token !== 'string') return false;
  try {
    const res = UrlFetchApp.fetch(
      'https://api.line.me/oauth2/v2.1/verify?access_token=' + encodeURIComponent(token),
      { muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) return false;

    const data = JSON.parse(res.getContentText());
    const channelId = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ID');

    // ตรวจว่า Token เป็นของ Channel เรา และยังไม่หมดอายุ
    if (!channelId || data.client_id !== channelId) return false;
    if (!data.expires_in || data.expires_in <= 0) return false;

    return true;
  } catch (e) {
    return false;
  }
}

function isAdmin(userId) {
  if (!userId || typeof userId !== 'string') return false;
  const raw = PropertiesService.getScriptProperties().getProperty('ADMIN_USER_IDS') || '';
  const admins = raw.split(',').map(s => s.trim()).filter(Boolean);
  return admins.includes(userId);
}

// ─── Routing ─────────────────────────────────────────────────

function doGet(e) {
  const action = e.parameter.action;
  const token  = e.parameter.token  || '';
  const userId = e.parameter.userId || '';

  // getConfig: ไม่ต้องยืนยันตัวตน (แค่พิกัดเป้าหมาย ไม่ใช่ข้อมูล sensitive)
  if (action === 'getConfig') {
    return jsonResponse(getConfig());
  }

  // checkAdmin: ตรวจว่า userId นี้เป็น Admin ไหม
  if (action === 'checkAdmin') {
    if (!verifyLineToken(token)) return jsonResponse({ error: 'Unauthorized' });
    return jsonResponse({ isAdmin: isAdmin(userId) });
  }

  // getKnownFaces: ข้อมูล Biometric — ต้องยืนยันตัวตนก่อน
  if (action === 'getKnownFaces') {
    if (!verifyLineToken(token)) return jsonResponse({ error: 'Unauthorized' });
    return jsonResponse(getKnownFaces());
  }

  return jsonResponse({ error: 'Unknown action' });
}

function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ error: 'Invalid JSON body' });
  }

  const token  = data.lineToken  || '';
  const userId = data.lineUserId || '';
  const action = data.action;

  // ทุก POST ต้องมี Token ที่ valid
  if (!verifyLineToken(token)) {
    return jsonResponse({ error: 'Unauthorized' });
  }

  // logAttendance: พนักงานทุกคนที่ login LINE แล้วทำได้
  if (action === 'logAttendance') {
    return jsonResponse(logAttendance(data.name, data.lat, data.lng));
  }

  // actions ด้านล่างสงวนไว้สำหรับ Admin เท่านั้น
  if (!isAdmin(userId)) {
    return jsonResponse({ error: 'Forbidden' });
  }

  if (action === 'registerUser') {
    return jsonResponse(registerUser(data.name, data.faceDescriptor));
  }
  if (action === 'saveConfig') {
    return jsonResponse(saveConfig(data.lat, data.lng, data.radius));
  }

  return jsonResponse({ error: 'Unknown action' });
}

// ─── Users (Face Registration) ───────────────────────────────

function registerUser(name, faceDescriptor) {
  if (!name || !Array.isArray(faceDescriptor)) {
    return { error: 'ข้อมูลไม่ครบ' };
  }

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName('Users');

  if (!sheet) {
    sheet = ss.insertSheet('Users');
    // สร้าง Header row ไว้เสมอ เพื่อให้ getKnownFaces ข้าม row 0 ได้ถูกต้อง
    sheet.appendRow(['Name', 'FaceDescriptor', 'RegisteredAt']);
  }

  sheet.appendRow([sanitize(name), JSON.stringify(faceDescriptor), new Date()]);
  return { success: true, message: 'บันทึกข้อมูลหน้าเรียบร้อย' };
}

function getKnownFaces() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Users');
  if (!sheet) return [];

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return []; // มีแค่ Header หรือว่างเปล่า

  const users = [];
  for (let i = 1; i < data.length; i++) { // i=1 ข้าม Header row
    const name    = data[i][0];
    const jsonStr = data[i][1];
    if (name && jsonStr && typeof jsonStr === 'string') {
      try {
        users.push({ label: name, descriptor: JSON.parse(jsonStr) });
      } catch (e) { /* ข้าม row ที่ข้อมูลเสียหาย */ }
    }
  }
  return users;
}

// ─── Attendance (Log) ─────────────────────────────────────────

function logAttendance(name, lat, lng) {
  if (!name) return { error: 'ไม่มีชื่อพนักงาน' };

  // ── ตรวจสอบ GPS ฝั่ง Server ──────────────────────────────
  // วิธีนี้ทำให้ bypass ผ่าน curl โดยตรงไม่ได้
  const config = getConfig();
  if (config.radius && config.radius > 0 && config.lat && config.lng) {
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    if (isNaN(latNum) || isNaN(lngNum)) {
      return { error: 'ข้อมูล GPS ไม่ถูกต้อง' };
    }
    const dist = haversineKm(latNum, lngNum, config.lat, config.lng);
    if (dist > config.radius) {
      return {
        error: 'อยู่นอกพื้นที่ที่กำหนด (' + (dist * 1000).toFixed(0) + ' ม.)',
        outOfRange: true
      };
    }
  }
  // ──────────────────────────────────────────────────────────

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName('Attendance');
  if (!sheet) {
    sheet = ss.insertSheet('Attendance');
    sheet.appendRow(['Name', 'Time', 'Date', 'Latitude', 'Longitude', 'Google Map Link']);
  }

  const now     = new Date();
  const tz      = Session.getScriptTimeZone();
  const dateStr = Utilities.formatDate(now, tz, 'd/M/yyyy');
  const timeStr = Utilities.formatDate(now, tz, 'HH:mm:ss');
  const mapLink = (lat && lng)
    ? 'https://www.google.com/maps?q=' + parseFloat(lat) + ',' + parseFloat(lng)
    : '';

  sheet.appendRow([
    sanitize(name),
    timeStr,
    "'" + dateStr,
    lat ? parseFloat(lat) : '-',
    lng ? parseFloat(lng) : '-',
    mapLink
  ]);

  return { success: true, message: 'บันทึกเวลาสำเร็จ' };
}

// ─── Config (GPS Settings) ────────────────────────────────────

function saveConfig(lat, lng, radius) {
  const latNum    = parseFloat(lat);
  const lngNum    = parseFloat(lng);
  const radiusNum = parseFloat(radius);

  if (isNaN(latNum) || isNaN(lngNum) || isNaN(radiusNum)) {
    return { error: 'ข้อมูลตัวเลขไม่ถูกต้อง' };
  }

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName('Config');
  if (!sheet) {
    sheet = ss.insertSheet('Config');
    sheet.getRange('A1:B1').setValues([['Parameter', 'Value']]);
    sheet.getRange('A2').setValue('Target Latitude');
    sheet.getRange('A3').setValue('Target Longitude');
    sheet.getRange('A4').setValue('Allowed Radius (KM)');
    sheet.setColumnWidth(1, 150);
  }

  sheet.getRange('B2').setValue(latNum);
  sheet.getRange('B3').setValue(lngNum);
  sheet.getRange('B4').setValue(radiusNum);

  return { success: true, message: 'บันทึกการตั้งค่าเรียบร้อย' };
}

function getConfig() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Config');
  const cfg   = { lat: 0, lng: 0, radius: 0 };

  if (sheet) {
    const latVal    = sheet.getRange('B2').getValue();
    const lngVal    = sheet.getRange('B3').getValue();
    const radiusVal = sheet.getRange('B4').getValue();
    if (latVal    !== '') cfg.lat    = parseFloat(latVal);
    if (lngVal    !== '') cfg.lng    = parseFloat(lngVal);
    if (radiusVal !== '') cfg.radius = parseFloat(radiusVal);
  }

  return cfg;
}

// ─── Haversine (Server-side distance check) ───────────────────

function haversineKm(lat1, lon1, lat2, lon2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(lat1 * Math.PI / 180)
             * Math.cos(lat2 * Math.PI / 180)
             * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
