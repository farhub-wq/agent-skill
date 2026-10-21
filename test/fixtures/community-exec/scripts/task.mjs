// 测试夹具：可执行脚本，输出固定 JSON 供运行时断言。
process.stdout.write(JSON.stringify({ ok: true }));
