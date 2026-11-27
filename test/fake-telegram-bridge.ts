// Test double for the bridge: reports its pid on stderr and runs until killed.
console.error(`up ${process.pid}`);
setInterval(() => {}, 1000);
