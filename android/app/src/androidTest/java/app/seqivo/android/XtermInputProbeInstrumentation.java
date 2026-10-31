package app.seqivo.android;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Test APK only. Native keys feed an isolated xterm with no PTY, network input, or product form. */
public final class XtermInputProbeInstrumentation extends Instrumentation {
    private static final String ASCII = "abcXYZ09";
    private static final String SPECIAL = "printf '%s\\n' APP204_A1:\"$TMUX_PANE\" | tee -a app204-a1.txt";
    private static final String LIB_NAME = "seqivo-xterm-6.0.0.umd.js";
    private static final String CSS_NAME = "seqivo-xterm-6.0.0.css";
    private static final String LIB_SHA256 = "14903579ff54664cd72f8e8699e6961a6272c21863ec1c3b118cdc8af5d4a972";
    private static final String CSS_SHA256 = "854a7c0fb70e8b1a083c16797ab827299fb18744f5ad34f227b48337e33293c6";
    private static final String RESOURCE_ROOT = "/__seqivo_xterm_input_probe_6_0_0__/";
    private static final String[] EVENT_KINDS = {"keydown", "keypress", "keyup", "beforeinput", "input",
            "compositionstart", "compositionupdate", "compositionend"};

    private Activity activity;
    private WebView targetWeb;
    private WebViewClient originalClient;
    private WebViewClient probeClient;
    private URI expectedOrigin;
    private byte[] library;
    private byte[] stylesheet;
    private String stage = "configuration";
    private boolean installed;
    private final JSONObject report = new JSONObject();

    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            JSONObject fixture = new JSONObject(new String(Files.readAllBytes(
                    new File(getTargetContext().getFilesDir(), "seqivo-disposable-fixture.json").toPath()), StandardCharsets.UTF_8));
            require("app.seqivo.android".equals(getTargetContext().getPackageName()) && fixture.optBoolean("disposable"),
                    "Disposable ordinary APK required");
            expectedOrigin = URI.create(fixture.getString("origin"));
            require("https".equals(expectedOrigin.getScheme()) && expectedOrigin.getUserInfo() == null &&
                    ("10.0.2.2".equals(expectedOrigin.getHost()) || "127.0.0.1".equals(expectedOrigin.getHost()) ||
                            "localhost".equals(expectedOrigin.getHost())) &&
                    (expectedOrigin.getPath() == null || expectedOrigin.getPath().isEmpty()) &&
                    expectedOrigin.getQuery() == null && expectedOrigin.getFragment() == null,
                    "Exact disposable loopback HTTPS origin required");
            stage = "fixed-assets";
            library = checkedAsset(LIB_NAME, LIB_SHA256);
            stylesheet = checkedAsset(CSS_NAME, CSS_SHA256);
            report.put("xtermVersion", "6.0.0").put("librarySha256", LIB_SHA256)
                    .put("cssSha256", CSS_SHA256).put("ordinaryPackage", "app.seqivo.android")
                    .put("sink", "isolated-xterm-no-echo-no-pty-no-websocket");
            stage = "launch";
            activity = startActivitySync(new Intent(Intent.ACTION_MAIN)
                    .setClassName("app.seqivo.android", "app.seqivo.android.MainActivity")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            waitForIdleSync();
            stage = "same-origin-page";
            waitForPage();
            stage = "resource-interceptor";
            installResourceInterceptor();
            stage = "isolated-xterm";
            installIsolatedTerminal();
            JSONArray samples = new JSONArray();
            samples.put(safeSample("ascii-whole", ASCII, false));
            samples.put(safeSample("ascii-character-by-character", ASCII, true));
            JSONObject exactCharacters = safeSample("exact-a1-character-by-character", SPECIAL, true);
            samples.put(exactCharacters);
            if (exactCharacters.optBoolean("observationComplete") && exactCharacters.optBoolean("textMatched") &&
                    exactCharacters.optBoolean("enterWasSingleCr"))
                samples.put(safeSample("exact-a1-whole-string", SPECIAL, false));
            else samples.put(new JSONObject().put("sampleId", "exact-a1-whole-string")
                    .put("skipped", true).put("reason", "exact-character-sample-not-fully-matched"));
            report.put("samples", samples);
            stage = "cleanup";
            JSONObject cleanup = cleanup();
            report.put("cleanup", cleanup);
            require(cleanup.optBoolean("frameRemoved") && cleanup.optBoolean("clientRestored") &&
                    cleanup.optInt("parentKeyEvents") == 0, "Input isolation or cleanup not confirmed");
            report.put("result", "completed");
            saveReport();
            result.putString("seqivoXtermInputProbe", "completed");
            finish(Activity.RESULT_OK, result);
        } catch (Throwable failure) {
            try { report.put("result", "failed").put("failedStage", stage)
                    .put("failureType", failure.getClass().getSimpleName()); } catch (Exception ignored) { }
            try { report.put("cleanup", cleanup()); } catch (Exception cleanupFailure) {
                try { report.put("cleanup", new JSONObject().put("confirmed", false)
                        .put("failureType", cleanupFailure.getClass().getSimpleName())); } catch (Exception ignored) { }
            }
            try { saveReport(); } catch (Exception ignored) { }
            result.putString("seqivoXtermInputProbe", "failed");
            result.putString("failedStage", stage);
            result.putString("failureType", failure.getClass().getSimpleName());
            finish(Activity.RESULT_CANCELED, result);
        }
    }

    private byte[] checkedAsset(String name, String expectedHash) throws Exception {
        File file = new File(getTargetContext().getFilesDir(), name);
        require(file.isFile() && file.length() > 0 && file.length() < 1_000_000, "Fixed xterm asset unavailable");
        byte[] bytes = Files.readAllBytes(file.toPath());
        require(expectedHash.equals(hex(MessageDigest.getInstance("SHA-256").digest(bytes))),
                "Fixed xterm asset hash mismatch");
        return bytes;
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) out.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return out.toString();
    }

    private void installResourceInterceptor() {
        runOnMainSync(() -> {
            targetWeb = web();
            originalClient = targetWeb.getWebViewClient();
            require(originalClient != null, "Product WebViewClient unavailable");
            probeClient = new WebViewClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    String path = request.getUrl().getPath();
                    if (view == targetWeb && sameOrigin(request.getUrl().toString()) &&
                            !request.isForMainFrame() && RESOURCE_ROOT.concat("xterm.js").equals(path))
                        return new WebResourceResponse("text/javascript", "UTF-8", new ByteArrayInputStream(library));
                    if (view == targetWeb && sameOrigin(request.getUrl().toString()) &&
                            !request.isForMainFrame() && RESOURCE_ROOT.concat("xterm.css").equals(path))
                        return new WebResourceResponse("text/css", "UTF-8", new ByteArrayInputStream(stylesheet));
                    return originalClient.shouldInterceptRequest(view, request);
                }
                @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    return originalClient.shouldOverrideUrlLoading(view, request);
                }
                @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
                    originalClient.onPageStarted(view, url, favicon);
                }
                @Override public void onPageFinished(WebView view, String url) {
                    originalClient.onPageFinished(view, url);
                }
                @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                    originalClient.onReceivedSslError(view, handler, error);
                }
                @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                    originalClient.onReceivedError(view, request, error);
                }
                @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                    return originalClient.onRenderProcessGone(view, detail);
                }
            };
            targetWeb.setWebViewClient(probeClient);
            installed = true;
        });
    }

    private JSONObject sample(String id, String expected, boolean eachCharacter) throws Exception {
        stage = "sample-" + id;
        require("true".equals(js("window.__seqivoXtermProbe?.reset()===true")), "Independent terminal reset failed");
        waitForVisualState();
        requireFocus();
        String firstMismatch = null;
        int submittedCharacters = 0;
        if (eachCharacter) {
            for (int index = 0; index < expected.length(); index++) {
                requireFocus();
                sendStringSync(String.valueOf(expected.charAt(index)));
                submittedCharacters++;
                String prefix = expected.substring(0, index + 1);
                if (!waitForData(prefix, 1600)) { firstMismatch = "index-" + index; break; }
                waitForVisualState();
            }
        } else {
            requireFocus();
            sendStringSync(expected);
            submittedCharacters = expected.length();
            if (!waitForData(expected, 3500)) firstMismatch = "whole-string";
            waitForVisualState();
        }
        String beforeEnter = data();
        boolean textMatched = expected.equals(beforeEnter);
        boolean enterSent = false, enterObserved = false;
        if (textMatched) {
            requireFocus();
            sendKeyDownUpSync(KeyEvent.KEYCODE_ENTER);
            enterSent = true;
            enterObserved = waitForData(beforeEnter + "\r", 1600);
            waitForVisualState();
        }
        JSONObject captured = state();
        return new JSONObject().put("sampleId", id).put("expected", expected)
                .put("beforeEnter", beforeEnter).put("afterEnter", data())
                .put("submittedCharacters", submittedCharacters).put("firstMismatch", firstMismatch)
                .put("textMatched", textMatched).put("enterSent", enterSent).put("enterWasSingleCr", enterObserved &&
                        (beforeEnter + "\r").equals(data()))
                .put("focus", captured.getJSONObject("focus"))
                .put("parentKeyEvents", captured.getInt("parentKeyEvents"))
                .put("eventOverflow", captured.getBoolean("eventOverflow"))
                .put("events", captured.getJSONArray("events"))
                .put("onData", captured.getJSONArray("onData"))
                .put("onKey", captured.getJSONArray("onKey"));
    }

    private JSONObject safeSample(String id, String expected, boolean eachCharacter) throws Exception {
        try { return sample(id, expected, eachCharacter).put("observationComplete", true); }
        catch (Throwable failure) {
            JSONObject partial = new JSONObject().put("sampleId", id).put("expected", expected)
                    .put("observationComplete", false).put("failureType", failure.getClass().getSimpleName());
            try { partial.put("partialState", state()); } catch (Exception ignored) { }
            return partial;
        }
    }

    private void installIsolatedTerminal() throws Exception {
        String install = "(()=>{if(window.__seqivoXtermProbe)return false;"
                + "const host=document.createElement('div');host.id='seqivo-xterm-input-probe';"
                + "host.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#fff;pointer-events:auto';"
                + "const outer=host.attachShadow({mode:'open'}),frame=document.createElement('iframe');"
                + "frame.style.cssText='width:100%;height:100%;border:0;background:#fff';outer.appendChild(frame);"
                + "document.body.appendChild(host);const p={host,frame,events:[],onData:[],onKey:[],parentKeyEvents:0,eventOverflow:false};"
                + "const kinds=" + jsArray(EVENT_KINDS) + ";"
                + "p.parentListener=e=>{p.parentKeyEvents++;e.preventDefault();e.stopImmediatePropagation()};"
                + "for(const k of kinds)document.addEventListener(k,p.parentListener,true);"
                + "p.remove=()=>{try{p.term?.dispose()}catch{};for(const k of kinds)document.removeEventListener(k,p.parentListener,true);"
                + "host.remove();delete window.__seqivoXtermProbe;return !document.getElementById('seqivo-xterm-input-probe')&&!window.__seqivoXtermProbe};"
                + "window.__seqivoXtermProbe=p;return true})()";
        require("true".equals(js(install)), "Isolated frame installation failed");
        long end = SystemClock.elapsedRealtime() + 5000;
        while (!"true".equals(js("Boolean(window.__seqivoXtermProbe?.frame.contentDocument?.head)"))) {
            require(SystemClock.elapsedRealtime() < end, "Blank frame unavailable");
            SystemClock.sleep(50);
        }
        String resourceBase = expectedOrigin.toString() + RESOURCE_ROOT;
        String setup = "(()=>{const p=window.__seqivoXtermProbe,d=p.frame.contentDocument,w=p.frame.contentWindow;"
                + "const css=d.createElement('link');css.rel='stylesheet';css.href=" + JSONObject.quote(resourceBase + "xterm.css") + ";d.head.appendChild(css);"
                + "const script=d.createElement('script');script.src=" + JSONObject.quote(resourceBase + "xterm.js") + ";"
                + "script.onload=()=>{p.loaded=typeof w.Terminal==='function'};script.onerror=()=>{p.loadFailed=true};d.head.appendChild(script);"
                + "const kinds=" + jsArray(EVENT_KINDS) + ";"
                + "for(const kind of kinds)d.addEventListener(kind,e=>{if(p.events.length>=900){p.eventOverflow=true;return}"
                + "const t=p.textarea;const dom={kind:e.type,trusted:e.isTrusted,key:e.key??null,code:e.code??null,"
                + "keyCode:e.keyCode??null,charCode:e.charCode??null,isComposing:e.isComposing??null,"
                + "data:e.data??null,inputType:e.inputType??null,time:e.timeStamp,"
                + "textareaValue:t?.value??null,targetIsTextarea:e.composedPath().includes(t)};p.events.push(dom)},true);"
                + "p.reset=()=>{if(!p.loaded)return false;try{p.term?.dispose()}catch{};d.body.replaceChildren();"
                + "p.events=[];p.onData=[];p.onKey=[];p.eventOverflow=false;"
                + "const sink=d.createElement('div');sink.style.cssText='width:100%;height:100%;font-size:16px';d.body.appendChild(sink);"
                + "p.term=new w.Terminal({cols:80,rows:24,convertEol:false,allowTransparency:false});p.term.open(sink);"
                + "p.textarea=sink.querySelector('textarea.xterm-helper-textarea');if(!p.textarea)return false;"
                + "p.term.onData(data=>{if(p.onData.length<400)p.onData.push({data,time:w.performance.now()});else p.eventOverflow=true});"
                + "p.term.onKey(k=>{if(p.onKey.length<400)p.onKey.push({key:k.key,code:k.domEvent?.code??null,"
                + "keyCode:k.domEvent?.keyCode??null,charCode:k.domEvent?.charCode??null,time:w.performance.now()});else p.eventOverflow=true});"
                + "w.focus();p.term.focus();return d.activeElement===p.textarea};return true})()";
        require("true".equals(js(setup)), "Xterm frame setup failed");
        end = SystemClock.elapsedRealtime() + 8000;
        while (!"true".equals(js("Boolean(window.__seqivoXtermProbe?.loaded)"))) {
            require(!"true".equals(js("Boolean(window.__seqivoXtermProbe?.loadFailed)")), "Verified xterm resource load failed");
            require(SystemClock.elapsedRealtime() < end, "Verified xterm resource timed out");
            SystemClock.sleep(60);
        }
        runOnMainSync(() -> web().requestFocus());
    }

    private static String jsArray(String[] values) {
        JSONArray array = new JSONArray();
        for (String value : values) array.put(value);
        return array.toString();
    }

    private void requireFocus() throws Exception {
        AtomicReference<Boolean> nativeFocus = new AtomicReference<>(false);
        runOnMainSync(() -> nativeFocus.set(web().hasWindowFocus()));
        require(Boolean.TRUE.equals(nativeFocus.get()), "WebView window not focused");
        require("true".equals(js("(()=>{const p=window.__seqivoXtermProbe;return !!p?.textarea&&"
                + "document.activeElement===p.host&&p.host.shadowRoot.activeElement===p.frame&&"
                + "p.frame.contentDocument.activeElement===p.textarea})()")),
                "Keyboard focus escaped isolated xterm frame");
    }

    private boolean waitForData(String expected, long timeoutMs) throws Exception {
        long end = SystemClock.elapsedRealtime() + timeoutMs;
        do { if (expected.equals(data())) return true; SystemClock.sleep(35); }
        while (SystemClock.elapsedRealtime() < end);
        return expected.equals(data());
    }

    private String data() throws Exception {
        return unquote(js("window.__seqivoXtermProbe.onData.map(e=>e.data).join('')"));
    }

    private JSONObject state() throws Exception {
        String raw = js("(()=>{const p=window.__seqivoXtermProbe;return {focus:{parentFrame:document.activeElement===p.host&&"
                + "p.host.shadowRoot.activeElement===p.frame,"
                + "xtermTextarea:p.frame.contentDocument.activeElement===p.textarea},parentKeyEvents:p.parentKeyEvents,"
                + "eventOverflow:p.eventOverflow,events:p.events,onData:p.onData,onKey:p.onKey}})()");
        return new JSONObject(raw);
    }

    private JSONObject cleanup() throws Exception {
        JSONObject result = new JSONObject();
        if (installed && expectedOrigin != null) {
            try { JSONObject frame = new JSONObject(js("(()=>{const p=window.__seqivoXtermProbe;return {"
                    + "hadFrame:!!p,parentKeyEvents:p?.parentKeyEvents??0,frameRemoved:p?p.remove():"
                    + "!document.getElementById('seqivo-xterm-input-probe')}})()"));
                result.put("hadFrame", frame.optBoolean("hadFrame"))
                        .put("parentKeyEvents", frame.optInt("parentKeyEvents"))
                        .put("frameRemoved", frame.optBoolean("frameRemoved"));
            } catch (Exception failure) { result.put("frameRemoved", false); }
            AtomicReference<Boolean> restored = new AtomicReference<>(false);
            runOnMainSync(() -> { if (targetWeb != null && originalClient != null &&
                    targetWeb.getWebViewClient() == probeClient) {
                targetWeb.setWebViewClient(originalClient);
                restored.set(targetWeb.getWebViewClient() == originalClient);
            }});
            result.put("clientRestored", Boolean.TRUE.equals(restored.get()));
            installed = false;
        } else { result.put("frameRemoved", true).put("clientRestored", true); }
        return result;
    }

    private void waitForVisualState() throws Exception {
        CountDownLatch drawn = new CountDownLatch(1);
        runOnMainSync(() -> web().postVisualStateCallback(SystemClock.uptimeMillis(),
                new WebView.VisualStateCallback() { @Override public void onComplete(long id) {
                    web().postOnAnimation(() -> web().postOnAnimation(drawn::countDown));
                }}));
        require(drawn.await(8, TimeUnit.SECONDS), "WebView rendering did not settle");
    }

    private void waitForPage() throws Exception {
        long end = SystemClock.elapsedRealtime() + 15000;
        do { try { if ("true".equals(js("Boolean(document.body)"))) return; } catch (Exception ignored) { }
            SystemClock.sleep(150); } while (SystemClock.elapsedRealtime() < end);
        throw new AssertionError("Same-origin WebView unavailable");
    }

    private WebView web() {
        WebView view = findWebView(activity.getWindow().getDecorView());
        require(view != null, "WebView unavailable"); return view;
    }

    private WebView findWebView(View root) {
        if (root instanceof WebView) return (WebView) root;
        if (root instanceof ViewGroup) { ViewGroup group = (ViewGroup) root;
            for (int i = 0; i < group.getChildCount(); i++) {
                WebView found = findWebView(group.getChildAt(i)); if (found != null) return found;
            }}
        return null;
    }

    private boolean sameOrigin(String candidate) {
        try { URI actual = URI.create(candidate);
            int actualPort = actual.getPort() < 0 ? 443 : actual.getPort();
            int expectedPort = expectedOrigin.getPort() < 0 ? 443 : expectedOrigin.getPort();
            return "https".equals(actual.getScheme()) && actual.getUserInfo() == null &&
                    expectedOrigin.getHost().equalsIgnoreCase(actual.getHost()) && actualPort == expectedPort;
        } catch (Exception ignored) { return false; }
    }

    private String js(String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> answer = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        runOnMainSync(() -> { try { WebView view = web();
            require(sameOrigin(view.getUrl()), "WebView origin mismatch");
            view.evaluateJavascript(script, value -> { answer.set(value); done.countDown(); });
        } catch (Throwable error) { failure.set(error); done.countDown(); } });
        require(done.await(8, TimeUnit.SECONDS), "WebView evaluation timed out");
        if (failure.get() != null) throw new AssertionError("Same-origin evaluation failed");
        return answer.get();
    }

    private String unquote(String quoted) throws Exception { return new JSONArray("[" + quoted + "]").getString(0); }

    private void saveReport() throws Exception {
        File output = new File(getTargetContext().getFilesDir(),
                "seqivo-xterm-probe-" + SystemClock.elapsedRealtime() + ".json");
        Files.write(output.toPath(), report.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static void require(boolean okay, String message) { if (!okay) throw new AssertionError(message); }
}
