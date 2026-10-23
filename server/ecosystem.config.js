// PM2 配置文件：宝塔 PM2 常驻时使用。
// 用法：pm2 start ecosystem.config.js；改完令牌/端口后 pm2 restart 51codetodo-sync。
// 注意：ACCESS_TOKEN 必须换成自己的强随机令牌，不要照抄占位符提交到公开仓库。
module.exports = {
  apps: [
    {
      name: "51codetodo-sync",
      script: "index.js",
      env: {
        NODE_ENV: "production",
        // 走 Nginx 反代时绑定回环即可，3170 不对公网监听；
        // 若没有反代、需要直接对外，再改为 0.0.0.0（不推荐，公网请走 HTTPS 反代）。
        HOST: "127.0.0.1",
        PORT: "3170",
        ACCESS_TOKEN: "sjFIWI23DD223DSAs12ffi22301FJQWASA1",
      },
    },
  ],
};
