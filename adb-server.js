import express from 'express';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
const app = express();

// ADB 命令路径
const ADB_PATH = '/opt/homebrew/bin/adb';

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

  // 替换命令中的 adb 为绝对路径
  const fullCommand = command.replace(/^adb\s/, `${ADB_PATH} `);
  exec(fullCommand, (error, stdout, stderr) => {
    if (error) {
      return res.status(500).send(error.message);
    }
    res.send(stdout);
  });
});

app.get('/api/screen', (req, res) => {
  try {
    // 先在设备上截图
    exec(`${ADB_PATH} shell screencap -p /sdcard/screen.png`, (error1) => {
      if (error1) {
        return res.status(500).send('截图失败');
      }
      
      // 然后拉取到本地
      exec(`${ADB_PATH} pull /sdcard/screen.png /tmp/screen.png`, (error2) => {
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

// 启动服务器
const server = app.listen(3003, () => {
  console.log('ADB server running on http://localhost:3003');
});

// 处理进程终止信号
function cleanup() {
  console.log('正在清理 ADB 服务...');
  
  // 关闭服务器
  server.close(() => {
    console.log('HTTP 服务器已关闭');
    
    // 停止 ADB 守护进程
    exec(`${ADB_PATH} kill-server`, (error, stdout, stderr) => {
      if (error) {
        console.error('关闭 ADB 守护进程失败:', error.message);
      } else {
        console.log('ADB 守护进程已关闭');
      }
      process.exit(0);
    });
  });
}

// 监听进程终止信号
process.on('SIGINT', cleanup);  // Ctrl+C
process.on('SIGTERM', cleanup); // 终止信号