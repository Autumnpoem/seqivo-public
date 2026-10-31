package app.seqivo.android;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
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

/** Diagnostic test APK only: native keys enter an isolated blank-frame shadow textarea. */
public final class KeyInputProbeInstrumentation extends Instrumentation {
    private static final String ASCII = "abcXYZ09";
    private static final String SPECIAL = "printf '%s\\n' APP204_A1:\"$TMUX_PANE\" | tee -a app204-a1.txt";
    private Activity activity;
    private URI expectedOrigin;
    private String stage = "configuration";
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
            require("https".equals(expectedOrigin.getScheme()) && expectedOrigin.getUserInfo()==null &&
                    ("10.0.2.2".equals(expectedOrigin.getHost()) || "127.0.0.1".equals(expectedOrigin.getHost()) || "localhost".equals(expectedOrigin.getHost())) &&
                    (expectedOrigin.getPath()==null || expectedOrigin.getPath().isEmpty()) &&
                    expectedOrigin.getQuery()==null && expectedOrigin.getFragment()==null,
                    "Exact disposable loopback HTTPS origin required");
            stage = "launch";
            activity = startActivitySync(new Intent(Intent.ACTION_MAIN)
                    .setClassName("app.seqivo.android", "app.seqivo.android.MainActivity")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            waitForIdleSync();
            stage = "same-origin-page";
            waitForPage();
            stage = "install-isolated-textarea";
            installIsolatedTextarea();
            JSONArray samples = new JSONArray();
            samples.put(sample("ascii-whole", ASCII, false));
            samples.put(sample("special-whole", SPECIAL, false));
            samples.put(sample("ascii-character-by-character", ASCII, true));
            samples.put(sample("special-character-by-character", SPECIAL, true));
            report.put("samples", samples);
            stage = "cleanup";
            report.put("cleanup", cleanup());
            require(report.getJSONObject("cleanup").optBoolean("hadProbe") &&
                    report.getJSONObject("cleanup").optBoolean("removed") &&
                    report.getJSONObject("cleanup").optInt("parentKeyEvents") == 0,
                    "Input isolation or cleanup not confirmed");
            report.put("result", "completed");
            saveReport();
            result.putString("seqivoKeyInputProbe", "completed");
            finish(Activity.RESULT_OK, result);
        } catch (Throwable failure) {
            try { report.put("result", "failed").put("failedStage", stage)
                    .put("failureType", failure.getClass().getSimpleName()); } catch (Exception ignored) { }
            if (expectedOrigin != null) {
                try { report.put("cleanup", cleanup()); } catch (Exception cleanupFailure) {
                    try { report.put("cleanup", new JSONObject().put("removed", false)
                            .put("failureType", cleanupFailure.getClass().getSimpleName())); } catch (Exception ignored) { }
                }
            }
            try { saveReport(); } catch (Exception ignored) { }
            result.putString("seqivoKeyInputProbe", "failed");
            result.putString("failedStage", stage);
            result.putString("failureType", failure.getClass().getSimpleName());
            finish(Activity.RESULT_CANCELED, result);
        }
    }

    private JSONObject sample(String id, String expected, boolean eachCharacter) throws Exception {
        stage = "sample-" + id;
        require("true".equals(js("(()=>{const p=window.__seqivoKeyProbe;return !!p&&p.frame.contentDocument?.body&&p.shadow.activeElement===p.textarea})()")),
                "Isolated textarea lost focus");
        require("true".equals(js("(()=>{const p=window.__seqivoKeyProbe;p.textarea.value='';p.events.length=0;return p.textarea.value===''})()")),
                "Textarea reset failed");
        String firstMismatch = null;
        int emitted = 0;
        if (eachCharacter) {
            for (int index=0; index<expected.length(); index++) {
                requireFocus();
                sendStringSync(String.valueOf(expected.charAt(index)));
                emitted++;
                String prefix = expected.substring(0,index+1);
                if (!waitForValue(prefix, 1500)) {
                    firstMismatch = "index-" + index;
                    break;
                }
                waitForVisualState();
            }
        } else {
            requireFocus();
            sendStringSync(expected);
            emitted = expected.length();
            if (!waitForValue(expected, 3000)) firstMismatch = "whole-string";
            waitForVisualState();
        }
        String beforeEnter = value();
        requireFocus();
        sendKeyDownUpSync(KeyEvent.KEYCODE_ENTER);
        boolean enterObserved = waitForValue(beforeEnter + "\n", 1500);
        waitForVisualState();
        JSONObject captured = state();
        return new JSONObject().put("sampleId", id).put("expected", expected).put("actualBeforeEnter", beforeEnter)
                .put("actualAfterEnter", value()).put("emittedCharacters", emitted)
                .put("firstMismatch", firstMismatch).put("textMatched", expected.equals(beforeEnter))
                .put("enterAppendedNewline", enterObserved).put("focus", captured.getJSONObject("focus"))
                .put("parentKeyEvents", captured.getInt("parentKeyEvents"))
                .put("events", captured.getJSONArray("events"));
    }

    private void installIsolatedTextarea() throws Exception {
        String install = "(()=>{if(window.__seqivoKeyProbe)return false;"
                + "const host=document.createElement('div');host.id='seqivo-key-probe';host.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#fff;pointer-events:auto';"
                + "const outer=host.attachShadow({mode:'open'}),frame=document.createElement('iframe');"
                + "frame.style.cssText='width:100%;height:100%;border:0;background:#fff';outer.appendChild(frame);document.body.appendChild(host);"
                + "const state={host,outer,frame,events:[],parentKeyEvents:0};"
                + "const parentListener=e=>{state.parentKeyEvents++;e.preventDefault();e.stopImmediatePropagation()};"
                + "const kinds=['keydown','keypress','keyup','beforeinput','input','compositionstart','compositionupdate','compositionend'];"
                + "for(const kind of kinds)document.addEventListener(kind,parentListener,true);"
                + "state.remove=()=>{for(const kind of kinds)document.removeEventListener(kind,parentListener,true);host.remove();delete window.__seqivoKeyProbe;return !document.getElementById('seqivo-key-probe')&&!window.__seqivoKeyProbe};"
                + "window.__seqivoKeyProbe=state;return true})()";
        require("true".equals(js(install)), "Isolated frame installation failed");
        long end = SystemClock.elapsedRealtime() + 5000;
        while (!"true".equals(js("Boolean(window.__seqivoKeyProbe?.frame.contentDocument?.body)"))) {
            require(SystemClock.elapsedRealtime() < end, "Blank frame unavailable");
            SystemClock.sleep(50);
        }
        String setup = "(()=>{const p=window.__seqivoKeyProbe,d=p.frame.contentDocument;"
                + "const holder=d.createElement('div');d.body.replaceChildren(holder);p.shadow=holder.attachShadow({mode:'open'});"
                + "const input=d.createElement('textarea');input.setAttribute('aria-label','isolated-key-input-probe');"
                + "input.style.cssText='position:absolute;left:24px;top:24px;width:calc(100% - 48px);height:180px;font:16px monospace';"
                + "p.shadow.appendChild(input);p.textarea=input;"
                + "for(const kind of ['keydown','keypress','keyup','beforeinput','input','compositionstart','compositionupdate','compositionend'])"
                + "d.addEventListener(kind,e=>{if(p.events.length>=3000)return;const path=e.composedPath();p.events.push({type:e.type,targetIsTextarea:path.includes(input),trusted:e.isTrusted,key:e.key??null,code:e.code??null,data:e.data??null,inputType:e.inputType??null,valueLength:input.value.length})},true);"
                + "p.frame.contentWindow.focus();input.focus();return d.activeElement===holder&&p.shadow.activeElement===input})()";
        runOnMainSync(() -> web().requestFocus());
        require("true".equals(js(setup)), "Independent shadow textarea focus failed");
        requireFocus();
    }

    private void requireFocus() throws Exception {
        AtomicReference<Boolean> nativeFocus = new AtomicReference<>(false);
        runOnMainSync(() -> nativeFocus.set(web().hasWindowFocus()));
        require(Boolean.TRUE.equals(nativeFocus.get()), "WebView window not focused");
        require("true".equals(js("(()=>{const p=window.__seqivoKeyProbe;return document.activeElement===p.host||document.activeElement===p.frame ? p.frame.contentDocument.activeElement===p.shadow.host&&p.shadow.activeElement===p.textarea : false})()")),
                "Keyboard focus escaped isolated frame");
    }

    private boolean waitForValue(String expected, long timeoutMs) throws Exception {
        long end = SystemClock.elapsedRealtime() + timeoutMs;
        do { if (expected.equals(value())) return true; SystemClock.sleep(35); }
        while (SystemClock.elapsedRealtime() < end);
        return expected.equals(value());
    }

    private String value() throws Exception {
        return unquote(js("window.__seqivoKeyProbe.textarea.value"));
    }

    private JSONObject state() throws Exception {
        String raw = js("(()=>{const p=window.__seqivoKeyProbe;return {focus:{parentFrame:document.activeElement===p.frame,nativeTextarea:p.shadow.activeElement===p.textarea},parentKeyEvents:p.parentKeyEvents,events:p.events}})()");
        return new JSONObject(raw);
    }

    private JSONObject cleanup() throws Exception {
        return new JSONObject(js("(()=>{const p=window.__seqivoKeyProbe;return {hadProbe:!!p,parentKeyEvents:p?.parentKeyEvents??0,removed:p?p.remove():!document.getElementById('seqivo-key-probe')}})()"));
    }

    private void waitForVisualState() throws Exception {
        CountDownLatch drawn = new CountDownLatch(1);
        runOnMainSync(() -> web().postVisualStateCallback(SystemClock.uptimeMillis(),
                new WebView.VisualStateCallback() { @Override public void onComplete(long id) {
                    web().postOnAnimation(() -> web().postOnAnimation(drawn::countDown));
                }}));
        require(drawn.await(8,TimeUnit.SECONDS), "WebView rendering did not settle");
    }

    private void waitForPage() throws Exception {
        long end = SystemClock.elapsedRealtime() + 15000;
        do { try { if ("true".equals(js("Boolean(document.body)"))) return; } catch (Exception ignored) { }
            SystemClock.sleep(150); } while (SystemClock.elapsedRealtime() < end);
        throw new AssertionError("Same-origin WebView unavailable");
    }

    private WebView web() {
        WebView view = findWebView(activity.getWindow().getDecorView());
        require(view!=null,"WebView unavailable"); return view;
    }

    private WebView findWebView(View root) {
        if (root instanceof WebView) return (WebView)root;
        if (root instanceof ViewGroup) { ViewGroup group=(ViewGroup)root;
            for(int i=0;i<group.getChildCount();i++){WebView found=findWebView(group.getChildAt(i));if(found!=null)return found;} }
        return null;
    }

    private String js(String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> answer = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        runOnMainSync(() -> { try {WebView view=web();URI actual=URI.create(view.getUrl());
            int actualPort=actual.getPort()<0?443:actual.getPort(),expectedPort=expectedOrigin.getPort()<0?443:expectedOrigin.getPort();
            require("https".equals(actual.getScheme())&&actual.getUserInfo()==null&&
                    expectedOrigin.getHost().equalsIgnoreCase(actual.getHost())&&actualPort==expectedPort,"WebView origin mismatch");
            view.evaluateJavascript(script,value->{answer.set(value);done.countDown();});
        } catch(Throwable error){failure.set(error);done.countDown();} });
        require(done.await(8,TimeUnit.SECONDS),"WebView evaluation timed out");
        if(failure.get()!=null)throw new AssertionError("Same-origin evaluation failed");
        return answer.get();
    }

    private String unquote(String quoted) throws Exception {return new JSONArray("["+quoted+"]").getString(0);}

    private void saveReport() throws Exception {
        File output=new File(getTargetContext().getFilesDir(),"seqivo-key-probe-"+SystemClock.elapsedRealtime()+".json");
        Files.write(output.toPath(),report.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static void require(boolean okay,String message){if(!okay)throw new AssertionError(message);}
}
