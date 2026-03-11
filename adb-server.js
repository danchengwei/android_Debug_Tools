import express from 'express';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
const app = express();

// 添加 CORS 支持
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

app.get('/api/adb', (req, res) => {
  const command = req.query.command;
  if (!command) {
    return res.status(400).send('Missing command');
  }

  exec(command, (error, stdout, stderr) => {
    if (error) {
      return res.status(500).send(error.message);
    }
    res.send(stdout);
  });
});

app.get('/api/screen', (req, res) => {
  try {
    // 先在设备上截图
    exec('adb shell screencap -p /sdcard/screen.png', (error1) => {
      if (error1) {
        return res.status(500).send('截图失败');
      }
      
      // 然后拉取到本地
      exec('adb pull /sdcard/screen.png /tmp/screen.png', (error2) => {
        if (error2) {
          return res.status(500).send('拉取截图失败');
        }
        
        // 读取文件并转换为 base64
        const filePath = path.join('/tmp', 'screen.png');
        const imageBuffer = fs.readFileSync(filePath);
        const base64Image = imageBuffer.toString('base64');
        const dataUrl = `data:image/png;base64,${base64Image}`;
        
        res.send(dataUrl);
      });
    });
  } catch (error) {
    res.status(500).send('截图处理失败');
  }
});

app.listen(3001, () => {
  console.log('ADB server running on http://localhost:3001');
});