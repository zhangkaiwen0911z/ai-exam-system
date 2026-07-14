# AI 智能考试系统 - 宝塔部署版

## 系统要求
- 操作系统：Linux（CentOS/Ubuntu/Debian）
- Node.js ≥ 18.0
- PM2（宝塔自带或 `npm install -g pm2`）

## 宝塔部署步骤

### 1. 上传源码
将 `exam-baota` 文件夹上传到服务器，例如 `/www/wwwroot/exam-system`

### 2. 安装 Node.js
宝塔面板 → 软件商店 → 搜索 Node.js → 安装版本 ≥ 18

### 3. 安装依赖
```bash
cd /www/wwwroot/exam-system
npm install
```

### 4. PM2 启动
宝塔面板 → 软件商店 → PM2 管理器 → 添加项目：
- 启动文件：`src/server.js`
- 项目目录：`/www/wwwroot/exam-system`

或命令行：
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### 5. 设置反向代理（域名访问）
宝塔面板 → 网站 → 添加站点 → 反向代理
- 目标 URL：`http://127.0.0.1:3501`

### 6. 防火墙放行
宝塔面板 → 安全 → 放行端口 3501

## 访问
浏览器打开 `http://你的服务器IP:3501`
首次访问注册第一个账号即为管理员。

## 常用命令
```bash
pm2 start ecosystem.config.js    # 启动
pm2 stop exam-system             # 停止
pm2 restart exam-system          # 重启
pm2 logs exam-system             # 查看日志
pm2 status                       # 查看状态
```

## 目录结构
```
exam-baota/
├── src/
│   ├── server.js         # 后端服务
│   └── database.js       # 数据库（sql.js）
├── public/
│   ├── index.html        # 主页面
│   └── login.html        # 登录页
├── data/                 # 数据库文件（自动生成）
├── logs/                 # 运行日志
├── package.json
├── ecosystem.config.js   # PM2 配置
└── .env                  # 环境变量
```
