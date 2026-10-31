package app.seqivo.android;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.Gravity;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.window.OnBackInvokedDispatcher;
import android.window.OnBackInvokedCallback;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.net.http.SslError;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

public final class MainActivity extends Activity {
    private static final String PREFERENCES = "connection";
    private static final String ORIGIN = "origin";
    private static final int CHANGE_SERVER = 1;
    private LinearLayout root;
    private WebView webView;
    private FrameLayout siteContainer;
    private LinearLayout loadingOverlay;
    private String origin;
    private OnBackInvokedCallback backCallback;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private Runnable loadTimeout;
    private Runnable readyCheck;
    private long loadStartedAt;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        getWindow().setStatusBarColor(getColor(R.color.native_surface));
        getWindow().setNavigationBarColor(getColor(R.color.native_surface));
        getWindow().getDecorView().setSystemUiVisibility(dark ? 0 :
                View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(getColor(R.color.native_background));
        root.setFitsSystemWindows(true);
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 33) {
            backCallback = this::handleBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
        }
        SharedPreferences preferences = getSharedPreferences(PREFERENCES, MODE_PRIVATE);
        origin = OriginPolicy.normalize(preferences.getString(ORIGIN, ""));
        if (origin == null) origin = OriginPolicy.normalize(BuildConfig.DEFAULT_ORIGIN);
        if (origin == null) showSetup(null); else openSite();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private TextView text(String value, int size) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(getColor(R.color.native_text));
        return view;
    }

    private LinearLayout panel() {
        removeWebView();
        root.removeAllViews();
        ScrollView scroller = new ScrollView(this);
        scroller.setFillViewport(true);
        scroller.setClipToPadding(false);
        root.addView(scroller, new LinearLayout.LayoutParams(-1, -1));
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(24), dp(32), dp(24), dp(32));
        scroller.addView(content, new ScrollView.LayoutParams(-1, -2));
        return content;
    }

    private void showSetup(String error) {
        LinearLayout content = panel();
        TextView title = text("连接序程", 26);
        content.addView(title);
        TextView help = text("输入你的序程 Hub HTTPS 地址。账号登录、任务和对话会在服务器的真实页面中打开。", 15);
        LinearLayout.LayoutParams helpParams = new LinearLayout.LayoutParams(-1, -2);
        helpParams.topMargin = dp(16);
        content.addView(help, helpParams);
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint("https://example.com");
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(origin == null ? "" : origin);
        input.setSelectAllOnFocus(true);
        LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(-1, -2);
        inputParams.topMargin = dp(24);
        content.addView(input, inputParams);
        TextView message = text(error == null ? "只接受有效证书的 HTTPS 地址。" : error, 14);
        LinearLayout.LayoutParams messageParams = new LinearLayout.LayoutParams(-1, -2);
        messageParams.topMargin = dp(8);
        content.addView(message, messageParams);
        Button connect = new Button(this);
        connect.setText("连接");
        LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(-1, -2);
        buttonParams.topMargin = dp(16);
        content.addView(connect, buttonParams);
        connect.setOnClickListener(view -> {
            String next = OriginPolicy.normalize(input.getText().toString());
            if (next == null) {
                message.setText("请输入完整的 HTTPS 地址，不含路径、账号或参数。");
                return;
            }
            origin = next;
            getSharedPreferences(PREFERENCES, MODE_PRIVATE).edit().putString(ORIGIN, next).apply();
            ((InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(input.getWindowToken(), 0);
            openSite();
        });
    }

    private void showConnectionError(String message) {
        LinearLayout content = panel();
        content.addView(text("连接未完成", 24));
        TextView details = text(message, 15);
        LinearLayout.LayoutParams detailsParams = new LinearLayout.LayoutParams(-1, -2);
        detailsParams.topMargin = dp(16);
        content.addView(details, detailsParams);
        Button retry = new Button(this);
        retry.setText("重试");
        content.addView(retry);
        retry.setOnClickListener(view -> openSite());
        Button change = new Button(this);
        change.setText("更换服务器地址");
        content.addView(change);
        change.setOnClickListener(view -> showSetup(null));
    }

    private void openSite() {
        if (origin == null) { showSetup(null); return; }
        removeWebView();
        root.removeAllViews();
        loadStartedAt = SystemClock.elapsedRealtime();
        siteContainer = new FrameLayout(this);
        webView = new WebView(this);
        // Feature hint only: this container does not need browser PWA installation.
        // Set before loadUrl; changing it during a load would trigger navigation again.
        webView.getSettings().setUserAgentString(webView.getSettings().getUserAgentString()
                + " SeqivoAndroid/" + BuildConfig.VERSION_NAME);
        webView.setBackgroundColor(getColor(R.color.native_surface));
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setAllowContentAccess(false);
        webView.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        webView.getSettings().setSafeBrowsingEnabled(true);
        webView.getSettings().setJavaScriptCanOpenWindowsAutomatically(false);
        webView.getSettings().setSupportMultipleWindows(false);
        WebView.setWebContentsDebuggingEnabled(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request.isForMainFrame() && !OriginPolicy.contains(origin, request.getUrl().toString())) {
                    Toast.makeText(MainActivity.this, "仅允许打开当前服务器的页面", Toast.LENGTH_SHORT).show();
                    return true;
                }
                return false;
            }

            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (!OriginPolicy.contains(origin, url)) view.stopLoading();
                else traceLoad("page-start");
            }

            @Override public void onPageFinished(WebView view, String url) {
                if (view != webView) return;
                traceLoad("page-finished");
                checkForContent(view);
            }

            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                if (view == webView) showConnectionError("服务器证书未通过系统校验。请检查 HTTPS 地址和证书后重试。");
            }

            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (view == webView && request.isForMainFrame()) showConnectionError("无法连接服务器。请检查网络和 Hub 地址后重试。");
            }

            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                if (view == webView) showConnectionError("页面已中断。请重试连接。");
                return true;
            }
        });
        siteContainer.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        loadingOverlay = new LinearLayout(this);
        loadingOverlay.setOrientation(LinearLayout.VERTICAL);
        loadingOverlay.setGravity(Gravity.CENTER);
        loadingOverlay.setBackgroundColor(getColor(R.color.native_surface));
        loadingOverlay.setPadding(dp(24), dp(24), dp(24), dp(24));
        loadingOverlay.addView(new ProgressBar(this), new LinearLayout.LayoutParams(-2, -2));
        TextView loadingText = text("正在加载序程 Hub…", 16);
        LinearLayout.LayoutParams loadingParams = new LinearLayout.LayoutParams(-2, -2);
        loadingParams.topMargin = dp(20);
        loadingOverlay.addView(loadingText, loadingParams);
        siteContainer.addView(loadingOverlay, new FrameLayout.LayoutParams(-1, -1));
        root.addView(siteContainer, new LinearLayout.LayoutParams(-1, -1));
        WebView loadingView = webView;
        loadTimeout = () -> {
            if (webView == loadingView && loadingOverlay != null)
                showConnectionError("页面加载时间过长。请检查网络和 Hub 地址后重试。");
        };
        mainHandler.postDelayed(loadTimeout, 45_000);
        traceLoad("native-ready");
        webView.loadUrl(origin + "/");
    }

    private void checkForContent(WebView view) {
        if (view != webView || loadingOverlay == null) return;
        view.evaluateJavascript("(()=>{const r=document.getElementById('root');return Boolean(r&&r.textContent&&r.textContent.trim().length>0)})()", result -> {
            if (view != webView || loadingOverlay == null) return;
            if ("true".equals(result)) {
                traceLoad("content-ready");
                mainHandler.removeCallbacks(loadTimeout);
                if (readyCheck != null) mainHandler.removeCallbacks(readyCheck);
                siteContainer.removeView(loadingOverlay);
                loadingOverlay = null;
            } else {
                readyCheck = () -> checkForContent(view);
                mainHandler.postDelayed(readyCheck, 350);
            }
        });
    }

    private void traceLoad(String stage) {
        if (BuildConfig.DEBUG)
            Log.i("SeqivoAndroid", stage + " elapsedMs=" + (SystemClock.elapsedRealtime() - loadStartedAt));
    }

    private void removeWebView() {
        if (loadTimeout != null) mainHandler.removeCallbacks(loadTimeout);
        if (readyCheck != null) mainHandler.removeCallbacks(readyCheck);
        loadTimeout = null;
        readyCheck = null;
        if (webView == null) return;
        WebView old = webView;
        webView = null;
        old.stopLoading();
        old.setWebChromeClient(null);
        old.setWebViewClient(null);
        if (siteContainer != null) root.removeView(siteContainer);
        old.destroy();
        siteContainer = null;
        loadingOverlay = null;
    }

    @Override public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, CHANGE_SERVER, 0, "更换服务器地址");
        return true;
    }

    @Override public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == CHANGE_SERVER) { showSetup(null); return true; }
        return super.onOptionsItemSelected(item);
    }

    private void handleBack() {
        if (webView != null) {
            WebView current = webView;
            current.evaluateJavascript(
                    "document.dispatchEvent(new Event('seqivo:native-back',{bubbles:true,cancelable:true}))",
                    result -> {
                        if (webView != current || "false".equals(result)) return;
                        if (current.canGoBack()) current.goBack(); else finish();
                    });
            return;
        }
        finish();
    }

    @Override public void onBackPressed() {
        handleBack();
    }

    @Override protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override protected void onDestroy() {
        if (Build.VERSION.SDK_INT >= 33 && backCallback != null)
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
        removeWebView();
        super.onDestroy();
    }
}
