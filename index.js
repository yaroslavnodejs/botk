const express = require('express');
const multer = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const CONFIG = {
  AWS: {
    accessKeyId: '5CTXEZE7GG2E373N5LXB',
    secretAccessKey: 'OX8d09wM8DybUDa7krVrbEAlPiQqTQkBeE0n1M2l',
    endpoint: 'https://s3.twcstorage.ru',
    bucket: '8e4faace-47805ca4-a98f-4731-9885-c3061577a358',
    region: 'ru-1',
  },
  MAX_FILE_SIZE: 10 * 1024 * 1024,
  MAX_EXPIRE_DAYS: 60,
  SERVER_PORT: 3000,
};

const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml']);
const allowedVideoTypes = new Set(['video/mp4', 'video/webm', 'video/ogg']);

const s3Client = new S3Client({
  region: CONFIG.AWS.region,
  endpoint: CONFIG.AWS.endpoint,
  credentials: {
    accessKeyId: CONFIG.AWS.accessKeyId,
    secretAccessKey: CONFIG.AWS.secretAccessKey,
  },
  forcePathStyle: true,
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: CONFIG.MAX_FILE_SIZE } });

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.resolve('./views'));
app.use(express.urlencoded({ extended: true }));

// Утилиты
const safeRender = (res, status, view, data) => res.status(status).render(view, data);

async function s3Upload(key, body, contentType) {
  const command = new PutObjectCommand({ Bucket: CONFIG.AWS.bucket, Key: key, Body: body, ContentType: contentType });
  return s3Client.send(command);
}

async function s3GetJson(key) {
  try {
    const command = new GetObjectCommand({ Bucket: CONFIG.AWS.bucket, Key: key });
    const data = await s3Client.send(command);
    const chunks = [];
    for await (const chunk of data.Body) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    if (e.name === 'NoSuchKey') return null;
    throw e;
  }
}

// Логика пасты
async function storePaste(content, expireDays) {
  if (!Array.isArray(content) || !content.length) throw new Error('Паста пуста');
  const pasteId = uuidv4();
  const now = Date.now();
  const daysToExpire = Math.min(expireDays || 7, CONFIG.MAX_EXPIRE_DAYS);
  const meta = {
    id: pasteId,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + daysToExpire * 864e5).toISOString(),
    content,
  };
  await s3Upload(`pastes/${pasteId}/metadata.json`, JSON.stringify(meta, null, 2), 'application/json');
  return pasteId;
}

async function loadPaste(pasteId) {
  if (!pasteId) throw new Error('Неверный ID пасты');
  const paste = await s3GetJson(`pastes/${pasteId}/metadata.json`);
  if (!paste) throw new Error('Паста не найдена или устарела');
  return paste;
}

// Маршруты
app.get('/', (req, res) => safeRender(res, 200, 'index', { message: null, paste_id: null, text: '' }));

app.post('/create', upload.single('file'), async (req, res) => {
  try {
    const { text = '', expire = 7 } = req.body;
    const expireDays = Number(expire);
    const file = req.file;

    if (!file && !text.trim()) return safeRender(res, 400, 'index', { message: 'Введите текст или загрузите файл', paste_id: null, text });

    const content = [];

    if (file) {
      let type = 'file';

      if (allowedImageTypes.has(file.mimetype)) type = 'image';
      else if (allowedVideoTypes.has(file.mimetype)) type = 'video';

      const pasteIdTemp = uuidv4();
      const ext = path.extname(file.originalname);
      const key = `uploads/${pasteIdTemp}${ext}`;
      await s3Upload(key, file.buffer, file.mimetype);

      content.push({
        type,
        file_name: file.originalname,
        s3_key: key,
        url: `${CONFIG.AWS.endpoint}/${CONFIG.AWS.bucket}/${key}`
      });
    }

    if (text.trim()) {
      content.unshift({ type: 'text', data: text.trim() });
    }

    const pasteId = await storePaste(content, expireDays);
    safeRender(res, 200, 'index', { message: `Паста создана! Код: ${pasteId}`, paste_id: pasteId, text: '' });
  } catch {
    safeRender(res, 500, 'index', { message: 'Ошибка сервера, попробуйте позже.', paste_id: null, text: '' });
  }
});

app.get('/paste/:pasteId', async (req, res) => {
  try {
    const paste = await loadPaste(req.params.pasteId);
    const expiresAt = new Date(paste.expires_at).getTime();
    const now = Date.now();
    let timeLeft = 'Паста устарела';

    if (expiresAt > now) {
      let diffMs = expiresAt - now;
      const days = Math.floor(diffMs / 86400000);
      diffMs -= days * 86400000;
      const hours = Math.floor(diffMs / 3600000);
      diffMs -= hours * 3600000;
      const minutes = Math.floor(diffMs / 60000);

      timeLeft = 'Истекает через ';
      if (days) timeLeft += `${days} дн. `;
      if (hours) timeLeft += `${hours} ч. `;
      if (minutes) timeLeft += `${minutes} мин.`;
      if (days === 0 && hours === 0 && minutes === 0) timeLeft = 'Истекает скоро';
    }

    res.render('view', { content: paste.content, timeLeft });
  } catch {
    res.status(404).send('Паста не найдена');
  }
});

const PORT = process.env.PORT || CONFIG.SERVER_PORT;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server started on port ${PORT}`);
});
