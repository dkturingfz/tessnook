// 在页面渲染前应用用户选择的外观，避免深色用户每次打开先闪一下浅色。
// 内容安全策略禁止内联脚本，所以作为同源脚本同步加载。
(function () {
  try {
    var t = JSON.parse(localStorage.getItem('tessnook:prefs') || '{}').theme;
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* 读取失败时跟随系统 */ }
})();
