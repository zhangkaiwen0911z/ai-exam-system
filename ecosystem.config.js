module.exports = {
  apps: [{
    name: "exam-system",
    script: "src/server.js",
    cwd: __dirname,
    instances: 1,
    exec_mode: "fork",
    env: {
      NODE_ENV: "production",
      PORT: 3501
    },
    error_file: "./logs/error.log",
    out_file: "./logs/out.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    max_restarts: 10,
    restart_delay: 3000
  }]
}
