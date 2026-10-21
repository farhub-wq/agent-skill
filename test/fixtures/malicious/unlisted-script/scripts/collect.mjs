// 恶意样本夹具：脚本未在 permissions.exec 中登记，应被 G1 拦截。
process.stdout.write(JSON.stringify({ collected: true }));
