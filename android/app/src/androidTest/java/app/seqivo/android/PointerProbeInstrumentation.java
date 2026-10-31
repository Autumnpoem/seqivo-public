package app.seqivo.android;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.webkit.WebView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Disposable, same-origin native touch probe. It never submits a product form. */
public final class PointerProbeInstrumentation extends Instrumentation {
    private Activity activity;
    private URI expectedOrigin;
    private String stage = "configuration";
    private final JSONObject report = new JSONObject();

    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            File fixtureFile = new File(getTargetContext().getFilesDir(), "seqivo-disposable-fixture.json");
            JSONObject fixture = new JSONObject(new String(Files.readAllBytes(fixtureFile.toPath()), StandardCharsets.UTF_8));
            require("app.seqivo.android".equals(getTargetContext().getPackageName()) && fixture.optBoolean("disposable"), "Disposable ordinary APK required");
            expectedOrigin = URI.create(fixture.getString("origin"));
            require("https".equals(expectedOrigin.getScheme()) && expectedOrigin.getUserInfo() == null &&
                    ("10.0.2.2".equals(expectedOrigin.getHost()) || "127.0.0.1".equals(expectedOrigin.getHost()) || "localhost".equals(expectedOrigin.getHost())) &&
                    (expectedOrigin.getPath() == null || expectedOrigin.getPath().isEmpty()) && expectedOrigin.getQuery() == null && expectedOrigin.getFragment() == null,
                    "Loopback HTTPS fixture required");
            stage = "launch";
            activity = startActivitySync(new Intent(Intent.ACTION_MAIN)
                    .setClassName("app.seqivo.android", "app.seqivo.android.MainActivity")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            waitForIdleSync();
            stage = "same-origin-webview";
            waitForPage();
            stage = "install-static-probe";
            installProbe();
            waitForVisualState();
            stage = "original-motion-event";
            report.put("original", press(0));
            stage = "source-only-motion-event";
            report.put("touchscreenUnknownTool", press(1));
            stage = "finger-touchscreen-motion-event";
            report.put("fingerTouchscreen", press(2));
            stage = "cleanup";
            report.put("cleanup", removeProbe());
            require(report.getJSONObject("cleanup").optBoolean("removed"), "Probe cleanup not confirmed");
            runOnMainSync(() -> web().reload());
            waitForPage();
            report.put("sameOriginReloaded", true);
            report.put("result", "completed");
            saveReport();
            result.putString("seqivoPointerProbe", "completed");
            finish(Activity.RESULT_OK, result);
        } catch (Throwable failure) {
            // No fixture values, URL, page content, or raw exception message in the result.
            try { report.put("result", "failed").put("failedStage", stage).put("failureType", failure.getClass().getSimpleName()); } catch (Exception ignored) { }
            if (expectedOrigin != null) {
                try { report.put("cleanup", removeProbe()); } catch (Exception cleanupFailure) {
                    try { report.put("cleanup", new JSONObject().put("removed", false).put("failureType", cleanupFailure.getClass().getSimpleName())); } catch (Exception ignored) { }
                }
            }
            try { saveReport(); } catch (Exception ignored) { }
            result.putString("seqivoPointerProbe", "failed");
            result.putString("failedStage", stage);
            result.putString("failureType", failure.getClass().getSimpleName());
            finish(Activity.RESULT_CANCELED, result);
        }
    }

    private JSONObject press(int variant) throws Exception {
        require("true".equals(js("window.__seqivoPointerProbe?.ready===true")), "Probe not ready");
        require("true".equals(js("(()=>{const p=window.__seqivoPointerProbe,b=p.button,r=b.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;return r.width>0&&r.height>0&&x>=0&&y>=0&&x<innerWidth&&y<innerHeight&&document.elementFromPoint(x,y)===p.host&&p.shadow.elementFromPoint(x,y)===b})()")), "Probe button not on top");
        JSONObject before = snapshot();
        JSONObject point = new JSONObject(js("(()=>{const r=window.__seqivoPointerProbe.button.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,width:innerWidth}})()"));
        float[] screen = new float[2];
        runOnMainSync(() -> { int[] origin = new int[2]; WebView view = web(); view.getLocationOnScreen(origin);
            float scale = view.getWidth() / (float)point.optDouble("width");
            screen[0] = origin[0] + (float)point.optDouble("x") * scale;
            screen[1] = origin[1] + (float)point.optDouble("y") * scale; });
        long downTime = SystemClock.uptimeMillis();
        MotionEvent down = motion(downTime, downTime, MotionEvent.ACTION_DOWN, screen, variant);
        JSONObject properties = new JSONObject().put("source", down.getSource()).put("toolType", down.getToolType(0))
                .put("size", down.getSize()).put("touchMajor", down.getTouchMajor()).put("touchMinor", down.getTouchMinor());
        MotionEvent up = null;
        try { sendPointerSync(down); SystemClock.sleep(80);
            up = motion(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, screen, variant);
            sendPointerSync(up);
        } finally { down.recycle(); if (up != null) up.recycle(); }
        waitForIdleSync();
        SystemClock.sleep(200);
        JSONObject after = snapshot();
        JSONArray events = new JSONArray(unquote(js("JSON.stringify(window.__seqivoPointerProbe.events.slice("+before.getInt("eventCount")+"))")));
        return new JSONObject().put("input", properties).put("before", before).put("after", after)
                .put("submitDelta", after.getInt("submits") - before.getInt("submits"))
                .put("events", events);
    }

    private MotionEvent motion(long downTime, long eventTime, int action, float[] screen, int variant) {
        if (variant < 2) {
            MotionEvent event = MotionEvent.obtain(downTime, eventTime, action, screen[0], screen[1], 0);
            if (variant == 1) event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
            return event;
        }
        MotionEvent.PointerProperties pointer = new MotionEvent.PointerProperties();
        pointer.id = 0;
        pointer.toolType = MotionEvent.TOOL_TYPE_FINGER;
        MotionEvent.PointerCoords coords = new MotionEvent.PointerCoords();
        coords.x = screen[0]; coords.y = screen[1];
        // Match the original six-argument overload's axes; only source/tool differ.
        coords.pressure = 1f; coords.size = 1f;
        return MotionEvent.obtain(downTime, eventTime, action, 1,
                new MotionEvent.PointerProperties[]{pointer}, new MotionEvent.PointerCoords[]{coords},
                0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
    }

    private void installProbe() throws Exception {
        String script = "(()=>{if(window.__seqivoPointerProbe)return false;"
                + "const host=document.createElement('div');host.id='seqivo-pointer-probe';"
                + "host.style.cssText='position:fixed;z-index:2147483647;left:50%;top:50%;transform:translate(-50%,-50%);width:184px;height:88px;background:#fff;border:2px solid #000;pointer-events:auto';"
                + "const shadow=host.attachShadow({mode:'open'}),form=document.createElement('form'),button=document.createElement('button');button.type='submit';button.textContent='Probe';"
                + "button.style.cssText='display:block;width:160px;height:64px;margin:12px;pointer-events:auto';form.appendChild(button);shadow.appendChild(form);document.body.appendChild(host);"
                + "const state={ready:true,host,shadow,button,events:[],submits:0};"
                + "const eventTypes=['pointerdown','pointerup','touchstart','touchend','mousedown','mouseup','click'];"
                + "const listener=e=>{const path=e.composedPath(),hit=path.includes(button);if(state.events.length<80){const t=e.target,r=button.getBoundingClientRect(),x=Number.isFinite(e.clientX)?e.clientX:null,y=Number.isFinite(e.clientY)?e.clientY:null,v=visualViewport;state.events.push({type:e.type,tag:t?.tagName||null,path0:path[0]?.tagName||null,probe:hit,liveHit:x!==null&&y!==null&&document.elementFromPoint(x,y)===host&&shadow.elementFromPoint(x,y)===button,trusted:e.isTrusted,pointerType:e.pointerType||null,width:e.width??null,height:e.height??null,x,y,when:e.timeStamp,rect:[r.left,r.top,r.width,r.height],viewport:v?[v.offsetLeft,v.offsetTop,v.scale]:null});}"
                + "if(e.type==='click'&&!hit){e.preventDefault();e.stopImmediatePropagation();}};"
                + "for(const type of eventTypes)document.addEventListener(type,listener,true);"
                + "form.addEventListener('submit',e=>{e.preventDefault();e.stopPropagation();state.submits++;});"
                + "state.remove=()=>{for(const type of eventTypes)document.removeEventListener(type,listener,true);host.remove();delete window.__seqivoPointerProbe;return !document.getElementById('seqivo-pointer-probe')&&!window.__seqivoPointerProbe};"
                + "window.__seqivoPointerProbe=state;return true})()";
        require("true".equals(js(script)), "Probe install failed");
    }

    private JSONObject snapshot() throws Exception {
        return new JSONObject(js("(()=>{const p=window.__seqivoPointerProbe;return {submits:p.submits,eventCount:p.events.length,attached:p.button.isConnected}})()"));
    }

    private JSONObject removeProbe() throws Exception {
        String value = js("(()=>{const p=window.__seqivoPointerProbe;return {hadProbe:!!p,removed:p?p.remove():!document.getElementById('seqivo-pointer-probe')}})()");
        return new JSONObject(value);
    }

    private void waitForVisualState() throws Exception {
        CountDownLatch drawn = new CountDownLatch(1);
        runOnMainSync(() -> web().postVisualStateCallback(SystemClock.uptimeMillis(),
                new WebView.VisualStateCallback() { @Override public void onComplete(long id) {
                    web().postOnAnimation(() -> web().postOnAnimation(drawn::countDown));
                }}));
        require(drawn.await(8, TimeUnit.SECONDS), "WebView drawing timed out");
    }

    private void waitForPage() throws Exception {
        long end = SystemClock.elapsedRealtime() + 15000;
        do { try {
            if ("true".equals(js("Boolean(document.getElementById('root')?.textContent.trim())"))) {
                AtomicReference<Boolean> uncovered = new AtomicReference<>(false);
                runOnMainSync(() -> uncovered.set(activity.hasWindowFocus() &&
                        web().getParent() instanceof android.view.ViewGroup &&
                        ((android.view.ViewGroup)web().getParent()).getChildCount() == 1));
                if (uncovered.get()) return;
            }
        } catch (Exception ignored) { }
            SystemClock.sleep(150); } while (SystemClock.elapsedRealtime() < end);
        throw new AssertionError("Same-origin WebView unavailable");
    }

    private WebView web() {
        WebView view = findWebView(activity.getWindow().getDecorView());
        require(view != null, "WebView unavailable");
        return view;
    }

    private WebView findWebView(android.view.View root) {
        if (root instanceof WebView) return (WebView)root;
        if (root instanceof android.view.ViewGroup) { android.view.ViewGroup group = (android.view.ViewGroup)root;
            for (int i=0;i<group.getChildCount();i++) { WebView found=findWebView(group.getChildAt(i)); if (found!=null) return found; } }
        return null;
    }

    private String js(String script) throws Exception {
        CountDownLatch complete = new CountDownLatch(1);
        AtomicReference<String> answer = new AtomicReference<>();
        AtomicReference<Throwable> error = new AtomicReference<>();
        runOnMainSync(() -> { try {
            WebView view = web(); URI actual = URI.create(view.getUrl());
            int actualPort = actual.getPort()<0 ? 443 : actual.getPort();
            int expectedPort = expectedOrigin.getPort()<0 ? 443 : expectedOrigin.getPort();
            require("https".equals(actual.getScheme()) && actual.getUserInfo()==null &&
                    expectedOrigin.getHost().equalsIgnoreCase(actual.getHost()) && actualPort==expectedPort,
                    "WebView origin mismatch");
            view.evaluateJavascript(script, value -> { answer.set(value); complete.countDown(); });
        } catch (Throwable failure) { error.set(failure); complete.countDown(); } });
        require(complete.await(8, TimeUnit.SECONDS), "WebView script timed out");
        if (error.get()!=null) throw new AssertionError("Same-origin WebView script failed");
        return answer.get();
    }

    private String unquote(String jsonString) throws Exception {
        return new JSONArray("[" + jsonString + "]").getString(0);
    }

    private void saveReport() throws Exception {
        File output = new File(getTargetContext().getFilesDir(), "seqivo-pointer-probe-"+SystemClock.elapsedRealtime()+".json");
        Files.write(output.toPath(), report.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static void require(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
