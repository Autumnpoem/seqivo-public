package app.seqivo.android;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.webkit.CookieManager;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.EditText;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.net.URI;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Separate test APK; guarded page scripts operate real forms without cookie injection or a native bridge. */
public final class HubAcceptanceInstrumentation extends Instrumentation {
    private Bundle arguments;
    private Activity activity;
    private JSONObject fixture;
    private String step = "configuration";
    private final JSONArray checks = new JSONArray();

    @Override public void onCreate(Bundle values) { super.onCreate(values); arguments = values; start(); }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            File file = new File(getTargetContext().getFilesDir(), "seqivo-disposable-fixture.json");
            fixture = new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
            require(fixture.optBoolean("disposable"), "Only a disposable test fixture is allowed");
            require("app.seqivo.android".equals(getTargetContext().getPackageName()), "This acceptance runner targets the ordinary APK only");
            URI origin = URI.create(fixture.getString("origin"));
            require("https".equals(origin.getScheme()) && origin.getUserInfo() == null &&
                    ("10.0.2.2".equals(origin.getHost()) || "127.0.0.1".equals(origin.getHost()) || "localhost".equals(origin.getHost())) &&
                    (origin.getPath() == null || origin.getPath().isEmpty()) && origin.getQuery() == null && origin.getFragment() == null,
                    "Only an isolated loopback HTTPS origin is allowed");
            String phase = arguments.getString("phase", "login");
            require(phase.equals("login") || phase.equals("restore") || phase.equals("logout") || phase.equals("probe") || phase.equals("taskflow") || phase.equals("taskrestore") || phase.equals("terminalenroll") || phase.equals("terminalflow") || phase.equals("terminalresume") || (phase.equals("terminalaftera1") || phase.equals("terminalrecovera1")) || phase.equals("terminalrecoverbclear") || phase.equals("terminalafterbclear") || phase.equals("terminalresumeoffline") || phase.equals("terminalconnect") || phase.equals("terminalinputtrace") || phase.equals("terminalviewport") || phase.equals("terminalclearfixture") || phase.equals("terminalinspect") || phase.equals("terminaltapinspect"), "Unknown test phase");
            if (phase.equals("terminalrecoverbclear") || phase.equals("terminalafterbclear")) requireABPreflight(phase);
            if (phase.equals("terminalresumeoffline")) requireOfflinePreflight();
            // Diagnostic setup only: this phase does not count as server-entry or login acceptance.
            if (phase.equals("probe")) require(getTargetContext().getSharedPreferences("connection", 0)
                    .edit().putString("origin", fixture.getString("origin")).commit(), "Diagnostic origin setup failed");
            step = "launch";
            activity = startActivitySync(new Intent(Intent.ACTION_MAIN)
                    .setClassName("app.seqivo.android", "app.seqivo.android.MainActivity")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            waitForIdleSync();
            if (phase.equals("probe")) {
                step = "native-launch-without-test-javascript";
                SystemClock.sleep(5000);
                runOnMainSync(() -> require(web().getUrl()!=null, "Native WebView not available"));
                checks.put("diagnostic_native_launch_survived_five_seconds_no_test_javascript");
            } else if (phase.equals("login")) login();
            else if (phase.equals("restore")) assertBoard();
            else if (phase.equals("taskflow")) taskFlow();
            else if (phase.equals("taskrestore")) taskRestore();
            else if (phase.equals("terminalenroll")) terminalEnroll();
            else if (phase.equals("terminalflow")) terminalFlow();
            else if (phase.equals("terminalresume") || (phase.equals("terminalaftera1") || phase.equals("terminalrecovera1")) || phase.equals("terminalconnect")) terminalResume();
            else if (phase.equals("terminalrecoverbclear")) terminalRecoverBClear();
            else if (phase.equals("terminalafterbclear")) terminalAfterBClear();
            else if (phase.equals("terminalresumeoffline")) terminalResumeOffline();
            else if (phase.equals("terminalinputtrace")) terminalInputTrace();
            else if (phase.equals("terminalviewport")) terminalViewport();
            else if (phase.equals("terminalclearfixture")) terminalClearFixture();
            else if (phase.equals("terminaltapinspect")) terminalTapInspect();
            else if (phase.equals("terminalinspect")) {openTerminal();SystemClock.sleep(1000);terminalDiagnostics();checks.put("terminal_readonly_diagnostics_saved");}
            else logout();
            if (fixture.optBoolean("expectNativeMarker")) {
                runOnMainSync(() -> require(web().getSettings().getUserAgentString().contains(" SeqivoAndroid/"), "Native container marker missing"));
                checks.put("native_container_user_agent_marker_present");
            }
            runOnMainSync(() -> CookieManager.getInstance().flush());
            result.putString("seqivoResult", "passed");
            result.putString("phase", phase);
            result.putString("checks", checks.toString());
            writeReport(new JSONObject().put("result", "passed").put("phase", phase).put("checks", checks));
            finish(Activity.RESULT_OK, result);
        } catch (Throwable failure) {
            // The disposable fixture may retain a bounded terminal-only snapshot.
            // It contains no page body, cookies, socket payloads, or arbitrary exception text.
            if (arguments!=null && (arguments.getString("phase", "").equals("terminalresume") || (arguments.getString("phase", "").equals("terminalaftera1") || arguments.getString("phase", "").equals("terminalrecovera1")) || arguments.getString("phase", "").equals("terminalrecoverbclear") || arguments.getString("phase", "").equals("terminalafterbclear") || arguments.getString("phase", "").equals("terminalresumeoffline") || arguments.getString("phase", "").equals("terminalconnect"))) {
                try {
                    String snapshot=js("(()=>{const p=document.querySelector('.terminal-panel')||document;return {state:p.querySelector('.terminal-state')?.textContent||null,current:p.querySelector('.terminal-session-bar button span')?.textContent||null,notices:[...p.querySelectorAll('.terminal-notice,.terminal-error,.alert,.terminal-actions [role=status]')].map(x=>x.textContent.slice(0,400)),control:p.querySelector('.terminal-control-heading')?.textContent||null,targetMatches:p.querySelector('.terminal-target-label select')?.value==="+JSONObject.quote(fixture.optString("expectedTerminalTarget"))+",entry:document.querySelector('script[type=module][src]')?new URL(document.querySelector('script[type=module][src]').src).pathname:null,sessionRows:document.querySelectorAll('.terminal-session-row').length,canInterrupt:[...document.querySelectorAll('.terminal-keys button')].some(x=>x.textContent==='Ctrl+C'&&!x.disabled)}})()");
                    Files.write(new File(getTargetContext().getFilesDir(),"seqivo-terminal-flow-failure.json").toPath(),new JSONObject(snapshot).put("step",step).toString().getBytes(StandardCharsets.UTF_8));
                } catch (Exception ignored) {}
            }
            // Do not print credentials, DOM, cookies, or the evaluated script on failure.
            result.putString("seqivoResult", "failed");
            result.putString("failedStep", step);
            result.putString("failureType", failure.getClass().getSimpleName());
            try { writeReport(new JSONObject().put("result", "failed").put("failedStep", step)
                    .put("failureType", failure.getClass().getSimpleName()).put("checks", checks)); } catch (Exception ignored) {}
            finish(Activity.RESULT_CANCELED, result);
        }
    }

    private void login() throws Exception {
        step = "native-setup";
        AtomicReference<EditText> input = new AtomicReference<>();
        runOnMainSync(() -> input.set(find(activity.getWindow().getDecorView(), EditText.class, null)));
        if (input.get() == null) {
            // Exercise the real native menu action, rather than overwrite the saved origin.
            require(invokeMenuActionSync(activity, 1, 0), "Change-server menu unavailable");
            runOnMainSync(() -> input.set(find(activity.getWindow().getDecorView(), EditText.class, null)));
            require(input.get() != null, "Native server form unavailable");
        }
        if (input.get() != null) {
            runOnMainSync(() -> { input.get().setText("http://127.0.0.1"); find(activity.getWindow().getDecorView(), Button.class, "连接").performClick(); });
            AtomicReference<WebView> rejected = new AtomicReference<>();
            runOnMainSync(() -> rejected.set(find(activity.getWindow().getDecorView(), WebView.class, null)));
            require(rejected.get() == null, "HTTP must not open a WebView");
            checks.put("native_http_origin_rejected");
            runOnMainSync(() -> { input.get().setText(fixture.optString("origin")); find(activity.getWindow().getDecorView(), Button.class, "连接").performClick(); });
        }
        step = "https-login-page";
        waitJs("Boolean(document.querySelector('#account-username')&&document.querySelector('#account-password'))");
        checks.put("ordinary_webview_loaded_https_login");
        step = "account-login";
        setField("#account-username", fixture.getString("username"));
        setField("#account-password", fixture.getString("password"));
        require("true".equals(js("(()=>{const b=document.querySelector('.login-card button[type=submit]');if(!b||b.disabled)return false;b.click();return true})()")), "Login control unavailable");
        assertBoard();
        checks.put("account_password_login_through_form");
    }

    private void assertBoard() throws Exception {
        step = "authorized-project";
        waitJs("!document.querySelector('.login-screen') && Boolean(document.querySelector('select[aria-label=\"选择项目\"]'))");
        String name = JSONObject.quote(fixture.getString("projectName"));
        require("true".equals(js("(()=>{const s=[...document.querySelectorAll('select[aria-label=\"选择项目\"]')].find(x=>x.getClientRects().length);if(!s)return false;const o=[...s.options].find(x=>x.textContent==="+name+");if(!o)return false;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,o.value);s.dispatchEvent(new Event('change',{bubbles:true}));return true})()")), "Expected project unavailable");
        step = "task-list";
        clickButton("任务清单");
        waitJs("document.body.innerText.includes("+JSONObject.quote(fixture.getString("taskTitle"))+")");
        checks.put("authorized_project_and_task_rendered");
        step = "native-browser-shell";
        require("true".equals(js("!document.querySelector('link[rel=manifest]') && (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller)")), "Native page still has browser installation or an active worker");
        checks.put("native_page_has_no_manifest_or_active_worker");
        step = "account-identity";
        clickButton("账号");
        waitJs("Boolean(document.querySelector('.account-page')) && document.querySelector('.account-page').innerText.includes("+JSONObject.quote(fixture.getString("username"))+")");
        checks.put("expected_account_rendered");
        step = "terminal-entry";
        clickButton("远程终端");
        waitJs("Boolean(document.querySelector('.terminal-panel')) || document.body.innerText.includes('交互式终端')");
        checks.put("terminal_navigation_rendered_only");
        clickButton("任务清单");
    }

    private void logout() throws Exception {
        assertBoard();
        step = "logout";
        clickButton("账号");
        waitJs("Boolean(document.querySelector('.account-page'))");
        clickButton("退出登录");
        waitJs("Boolean(document.querySelector('#account-username'))");
        checks.put("logout_returned_to_login");
        runOnMainSync(() -> web().reload());
        waitJs("Boolean(document.querySelector('#account-username'))");
        checks.put("reload_remains_logged_out");
    }

    private void openFixtureTask() throws Exception {
        String title=JSONObject.quote(fixture.getString("taskTitle"));
        waitJs("(()=>{const rows=[...document.querySelectorAll('button.task-row')].filter(x=>x.querySelector('strong')?.textContent==="+title+");if(rows.length!==1)return false;rows[0].click();return true})()");
        waitJs("document.querySelector('section.detail-panel .detail-heading h2')?.textContent==="+title);
    }

    private void taskFlow() throws Exception {
        require(fixture.optBoolean("allowTaskWrites"),"Task writes require a disposable flow fixture");
        String marker=fixture.getString("taskFlowMarker");
        require(marker.startsWith("APP203 ")&&marker.length()<100,"Invalid task marker");
        assertBoard();
        step="task-edit";
        openFixtureTask();
        require("true".equals(js("!document.body.textContent.includes("+JSONObject.quote(marker)+")")),"This flow already ran; inspect receipts before another attempt");
        clickButton("编辑任务");
        waitJs("document.querySelector('#dialog-title')?.textContent==='编辑任务'");
        setField("textarea[aria-label=\"当前进展\"]",marker);
        clickButton("保存");
        waitJs("!document.querySelector('[role=dialog]') && document.body.textContent.includes("+JSONObject.quote(marker)+")");
        checks.put("task_progress_saved_through_form");
        step="task-evidence";
        clickButton("添加证据");
        waitJs("document.querySelector('#dialog-title')?.textContent==='添加证据'");
        setField("textarea[aria-label=\"证据说明\"]",marker+" evidence");
        setField("input[aria-label=\"证据引用\"]",marker+" receipt");
        clickButton("保存");
        waitJs("!document.querySelector('[role=dialog]') && document.body.textContent.includes("+JSONObject.quote(marker+" evidence")+")");
        checks.put("task_evidence_saved_through_form");
        step="inbox-decision";
        waitJs("(()=>{const b=[...document.querySelectorAll('nav.mobile-nav button')].find(x=>x.querySelector('span')?.textContent==='需要我处理');if(!b)return false;b.click();return true})()");
        clickButton("决策");
        String card="[...document.querySelectorAll('.inbox-card')].find(x=>x.querySelector('.inbox-context')?.textContent==='APP203 待处理决策')";
        waitJs("(()=>{const c="+card+";const b=c&&[...c.querySelectorAll('button')].find(x=>x.textContent.trim()==='答复决策'&&!x.disabled);if(!b)return false;b.click();return true})()");
        require("true".equals(js("(()=>{const s=("+card+")?.querySelector('select');if(!s||![...s.options].some(o=>o.value==='a'))return false;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'a');s.dispatchEvent(new Event('change',{bubbles:true}));return true})()")),"Decision option unavailable");
        clickButton("提交回答");
        waitJs("!("+card+")");
        assertHandledDecision();
        checks.put("decision_submitted_and_resolved_with_task_answer");
        taskRestore();
    }

    private void assertHandledDecision() throws Exception {
        step="decision-history";
        waitJs("(()=>{const b=[...document.querySelectorAll('nav.mobile-nav button')].find(x=>x.querySelector('span')?.textContent==='需要我处理');if(!b)return false;b.click();return true})()");
        clickButton("已处理");
        String card="[...document.querySelectorAll('.inbox-card')].find(x=>x.querySelector('.inbox-context')?.textContent==='APP203 待处理决策')";
        waitJs("Boolean(("+card+")?.querySelector('.inbox-card-head')?.textContent.includes('已处理'))");
        require("true".equals(js("(()=>{const c="+card+";const b=c&&[...c.querySelectorAll('button')].find(x=>x.textContent.trim()==='查看任务');if(!b)return false;b.click();return true})()")),"Handled task unavailable");
        waitJs("document.querySelector('section.detail-panel .detail-heading h2')?.textContent==='APP203 待处理决策' && document.querySelector('section.detail-panel')?.textContent.includes('方案 A')");
        checks.put("resolved_decision_history_links_to_saved_task_answer");
    }

    private void taskRestore() throws Exception {
        String marker=fixture.getString("taskFlowMarker");
        require(marker.startsWith("APP203 ")&&marker.length()<100,"Invalid task marker");
        step="task-flow-reload";
        runOnMainSync(()->web().reload());
        assertBoard();
        step="task-progress-and-evidence-restore";
        openFixtureTask();
        waitJs("document.body.textContent.includes("+JSONObject.quote(marker)+") && document.body.textContent.includes("+JSONObject.quote(marker+" evidence")+")");
        checks.put("progress_and_evidence_survive_page_reload");
        assertHandledDecision();
    }

    private void clickButton(String text) throws Exception {
        String predicate = "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==="+JSONObject.quote(text)+"&&x.getClientRects().length&&!x.disabled);if(!b)return false;b.click();return true})()";
        long end = SystemClock.elapsedRealtime()+10000;
        do { if ("true".equals(js(predicate))) return; SystemClock.sleep(150); } while(SystemClock.elapsedRealtime()<end);
        throw new AssertionError("Visible button unavailable");
    }

    private String visibleButton(String text) {
        return "(()=>{const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()==="+JSONObject.quote(text)+"&&x.getClientRects().length&&!x.disabled);return b.length===1?b[0]:null})()";
    }

    // Native pointer delivery, after checking the DOM target is visible and not covered.
    private void tapElement(String expression) throws Exception {
        waitJs("(()=>{const e="+expression+";if(!e||e.disabled)return false;e.scrollIntoView({block:'center',inline:'center'});return true})()");
        CountDownLatch drawn=new CountDownLatch(1);
        runOnMainSync(()->web().postVisualStateCallback(SystemClock.uptimeMillis(),new WebView.VisualStateCallback(){@Override public void onComplete(long requestId){web().postOnAnimation(()->web().postOnAnimation(drawn::countDown));web().invalidate();}}));
        require(drawn.await(8,TimeUnit.SECONDS),"WebView visual update timed out");
        // A rendered frame can precede the IME resize. Wait for the target and
        // viewport to settle before sending exactly one native pointer gesture.
        // This never retries the gesture or invokes the DOM click handler.
        JSONObject point=null,previous=null;
        long deadline=SystemClock.elapsedRealtime()+5000,stableSince=0;
        String[] geometry={"x","y","targetWidth","targetHeight","width","height","viewportHeight","viewportTop"};
        while(SystemClock.elapsedRealtime()<deadline) {
            String raw=js("(()=>{const e="+expression+";if(!e||e.disabled)return null;const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y),v=visualViewport;if(r.width<=0||r.height<=0||x<0||y<0||x>=innerWidth||y>=innerHeight||!(h===e||e.contains(h)))return null;return {x,y,targetWidth:r.width,targetHeight:r.height,width:innerWidth,height:innerHeight,viewportHeight:v?.height??innerHeight,viewportTop:v?.offsetTop??0}})()");
            JSONObject current=raw==null||raw.equals("null")?null:new JSONObject(raw);
            boolean stable=current!=null&&previous!=null;
            if(stable)for(String key:geometry)if(Math.abs(current.getDouble(key)-previous.getDouble(key))>0.5){stable=false;break;}
            long observedAt=SystemClock.elapsedRealtime();
            if(!stable)stableSince=observedAt;
            if(stable&&observedAt-stableSince>=350){point=current;break;}
            previous=current;
            SystemClock.sleep(75);
        }
        require(point!=null,"Terminal control did not become visible and stable");
        final JSONObject targetPoint=point;
        float[] position=new float[2];
        runOnMainSync(()->{int[] origin=new int[2];WebView w=web();w.getLocationOnScreen(origin);float scale=w.getWidth()/(float)targetPoint.optDouble("width");position[0]=origin[0]+(float)targetPoint.optDouble("x")*scale;position[1]=origin[1]+(float)targetPoint.optDouble("y")*scale;});
        long now=SystemClock.uptimeMillis();
        MotionEvent down=MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,position[0],position[1],0);
        MotionEvent up=null;
        try{sendPointerSync(down);SystemClock.sleep(80);up=MotionEvent.obtain(now,SystemClock.uptimeMillis(),MotionEvent.ACTION_UP,position[0],position[1],0);sendPointerSync(up);}finally{down.recycle();if(up!=null)up.recycle();}
        waitForIdleSync();
    }

    private void openTerminal() throws Exception {
        assertBoard();
        clickButton("远程终端");
        waitJs("Boolean(document.querySelector('.terminal-workspace'))");
    }

    private void terminalEnroll() throws Exception {
        require(fixture.optBoolean("allowTerminalWrites"),"Terminal fixture authorization required");
        openTerminal();step="terminal-device-enrollment";
        waitJs("[...document.querySelectorAll('.terminal-setup h3')].some(x=>x.textContent==='登记这台浏览器')");
        step="terminal-enrollment-field";
        setField(".terminal-setup form input","APP204 ordinary APK");
        step="terminal-enrollment-native-tap";
        js("(()=>{window.__seqivoQaPointer=[];const ids=new WeakMap();let id=0;const identity=n=>{if(!n)return null;if(!ids.has(n))ids.set(n,++id);return ids.get(n)};for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,e=>{const b=e.target.closest('button'),current=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='登记设备');window.__seqivoQaPointer.push({type:e.type,time:e.timeStamp,x:e.clientX,y:e.clientY,trusted:e.isTrusted,tag:e.target.tagName,cls:e.target.className,buttonId:identity(b),currentButtonId:identity(current),connected:e.target.isConnected,registrationButton:b?.textContent.trim()==='登记设备'});},{capture:true});return true})()");
        tapElement(visibleButton("登记设备"));
        String pointer=js("JSON.stringify(window.__seqivoQaPointer)");
        Files.write(new File(getTargetContext().getFilesDir(),"seqivo-terminal-pointer.json").toPath(),pointer.getBytes(StandardCharsets.UTF_8));
        step="terminal-enrollment-response";
        waitJs("Boolean(document.querySelector('.terminal-confirmation .terminal-code code')?.textContent)");
        String code=new JSONArray("["+js("document.querySelector('.terminal-confirmation .terminal-code code').textContent")+"]").getString(0);
        // Separate private handoff file; confirmation code is never included in reports or logs.
        Files.write(new File(getTargetContext().getFilesDir(),"seqivo-terminal-enrollment.json").toPath(),new JSONObject().put("label","APP204 ordinary APK").put("confirmationCode",code).toString().getBytes(StandardCharsets.UTF_8));
        checks.put("terminal_device_registered_through_native_pointer");
    }

    private void terminalDiagnostics() throws Exception {
        String value=js("(()=>{const p=document.querySelector('.terminal-panel')||document;const b=[...p.querySelectorAll('button')].find(x=>x.textContent.trim()==='登记设备'),r=b?.getBoundingClientRect();return {headings:[...p.querySelectorAll('h3')].map(x=>x.textContent),alerts:[...p.querySelectorAll('.alert')].map(x=>x.textContent),enrollmentButton:!!b,buttonRect:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null,codeVisible:!!p.querySelector('.terminal-code code'),innerWidth,innerHeight,scrollY,targetCount:p.querySelector('.terminal-target-label select')?.options.length}})()");
        JSONObject diagnostic=new JSONObject(value);
        runOnMainSync(()->{try{int[] location=new int[2];web().getLocationOnScreen(location);diagnostic.put("nativeX",location[0]).put("nativeY",location[1]).put("nativeWidth",web().getWidth()).put("nativeHeight",web().getHeight()).put("windowFocused",activity.hasWindowFocus());}catch(Exception ignored){}});
        Files.write(new File(getTargetContext().getFilesDir(),"seqivo-terminal-diagnostics.json").toPath(),diagnostic.toString().getBytes(StandardCharsets.UTF_8));
    }

    private void terminalTapInspect() throws Exception {
        openTerminal();step="terminal-native-tap-diagnostic";
        waitJs("[...document.querySelectorAll('.terminal-setup h3')].some(x=>x.textContent==='登记这台浏览器')");
        setField(".terminal-setup form input","APP204 ordinary APK");
        require("true".equals(js("(()=>{if(window.__seqivoTapProbe)return false;const state={events:[],submits:0},types=['pointerdown','pointerup','touchstart','touchend','mouseover','mousemove','mousedown','mouseup','click'];const record=e=>{const b=[...document.querySelectorAll('.terminal-setup button')].find(x=>x.textContent.trim()==='登记设备'),r=b?.getBoundingClientRect(),x=e.clientX??null,y=e.clientY??null,h=x!==null&&y!==null?document.elementFromPoint(x,y):null,v=visualViewport;state.events.push({type:e.type,time:e.timeStamp,tag:e.target.tagName,cls:e.target.className,x,y,pointerType:e.pointerType||null,trusted:e.isTrusted,documentFocused:document.hasFocus(),banners:[...document.querySelectorAll('.banner')].map(x=>({text:x.textContent,height:x.getBoundingClientRect().height})),liveTag:h?.tagName,liveClass:h?.className,hitRegistration:h===b||!!b?.contains(h),rect:r?[r.left,r.top,r.width,r.height]:null,viewport:v?[v.offsetLeft,v.offsetTop,v.width,v.height,v.scale]:null});if(e.type==='click'){e.preventDefault();e.stopImmediatePropagation();}};const submit=e=>{state.submits++;e.preventDefault();e.stopImmediatePropagation()};types.forEach(t=>document.addEventListener(t,record,true));window.addEventListener('focus',record,true);window.addEventListener('blur',record,true);document.addEventListener('submit',submit,true);state.remove=()=>{types.forEach(t=>document.removeEventListener(t,record,true));window.removeEventListener('focus',record,true);window.removeEventListener('blur',record,true);document.removeEventListener('submit',submit,true)};window.__seqivoTapProbe=state;return true})()")),"Tap diagnostic already installed");
        try {
            tapElement(visibleButton("登记设备"));SystemClock.sleep(400);
            String value=js("({events:window.__seqivoTapProbe.events,submits:window.__seqivoTapProbe.submits})");
            Files.write(new File(getTargetContext().getFilesDir(),"seqivo-terminal-tap-diagnostic.json").toPath(),value.getBytes(StandardCharsets.UTF_8));
            require(new JSONObject(value).getInt("submits")==0,"Diagnostic must intercept clicks before submission");
            checks.put("native_registration_tap_observed_with_submission_blocked");
        } finally {
            js("(()=>{window.__seqivoTapProbe?.remove();delete window.__seqivoTapProbe;return true})()");
        }
    }

    private String sessionRow(String name) {
        return "(()=>{const rows=[...document.querySelectorAll('.terminal-session-row')].filter(x=>x.querySelector('button strong')?.textContent==="+JSONObject.quote(name)+");return rows.length===1?rows[0]:null})()";
    }
    private void openSessionDrawer() throws Exception {
        if("true".equals(js("Boolean(document.querySelector('#terminal-session-drawer'))")))return;
        require("true".equals(js("(()=>{if(window.__seqivoDrawerProbe)return false;const original=WebSocket.prototype.send,s={events:[],listSent:0};const snapshot=(type,e)=>{const b=document.querySelector('.terminal-session-bar button'),r=b?.getBoundingClientRect(),v=visualViewport;if(s.events.length<120)s.events.push({type,trusted:e?.isTrusted??null,time:performance.now(),target:e?.target?.tagName||null,targetClass:e?.target?.className||null,buttonTarget:e?.target===b||Boolean(b?.contains(e?.target)),x:e?.clientX??null,y:e?.clientY??null,rect:r?{left:r.left,top:r.top,width:r.width,height:r.height}:null,viewport:v?{height:v.height,top:v.offsetTop}:null,inset:document.documentElement.style.getPropertyValue('--terminal-mobile-keyboard-inset'),focusedTerminal:document.activeElement===document.querySelector('.xterm-helper-textarea'),drawer:!!document.querySelector('#terminal-session-drawer')})};const types=['pointerdown','pointerup','pointercancel','mousedown','mouseup','click','focusin','focusout'];const observe=e=>snapshot(e.type,e);for(const t of types)document.addEventListener(t,observe,true);const resize=e=>snapshot('viewport-resize',e);visualViewport?.addEventListener('resize',resize);const wrapped=function(data){try{if(JSON.parse(data)?.type==='list')s.listSent++}catch{}return original.call(this,data)};WebSocket.prototype.send=wrapped;s.remove=()=>{for(const t of types)document.removeEventListener(t,observe,true);visualViewport?.removeEventListener('resize',resize);if(WebSocket.prototype.send!==wrapped)return false;WebSocket.prototype.send=original;delete window.__seqivoDrawerProbe;return true};window.__seqivoDrawerProbe=s;snapshot('before',null);return true})()")),"Drawer probe already active");
        try {
            tapElement("document.querySelector('.terminal-session-bar button')");
            waitJs("Boolean(document.querySelector('#terminal-session-drawer'))");
        } finally {
            try {
                String value=js("(()=>{const s=window.__seqivoDrawerProbe;return {events:s.events,listSent:s.listSent,drawer:!!document.querySelector('#terminal-session-drawer'),state:document.querySelector('.terminal-state')?.textContent||null}})()");
                Files.write(new File(getTargetContext().getFilesDir(),"seqivo-terminal-drawer-probe.json").toPath(),value.getBytes(StandardCharsets.UTF_8));
            } finally {require("true".equals(js("window.__seqivoDrawerProbe?.remove()===true")),"Drawer probe cleanup failed");}
        }
    }
    private void closeSessionDrawer() throws Exception {
        tapElement("document.querySelector('#terminal-session-drawer button[aria-label=\"关闭会话列表\"]')");
        waitJs("!document.querySelector('#terminal-session-drawer')");
    }
    private void terminalReady(String name) throws Exception {
        waitJs("document.querySelector('.terminal-state')?.textContent==='已连接' && document.querySelector('.terminal-session-bar button span')?.textContent==="+JSONObject.quote("会话："+name)+" && [...document.querySelectorAll('.terminal-keys button')].some(x=>x.textContent==='Ctrl+C'&&!x.disabled)");
    }
    private void assertDefault(String name) throws Exception {
        openSessionDrawer();
        waitJs("Boolean(("+sessionRow(name)+")?.textContent.includes('★ 默认')) && [...document.querySelectorAll('.terminal-session-row')].filter(x=>x.textContent.includes('★ 默认')).length===1");
        closeSessionDrawer();
    }
    private void terminalCommand(String marker,String filename) throws Exception {
        require(marker.matches("APP204_[AB][12]")&&filename.matches("app204-[ab][12]\\.txt"),"Unexpected terminal command marker");
        step="terminal-key-input-"+marker;
        require("true".equals(js("(()=>{const e=document.querySelector('.xterm-helper-textarea');if(!e)return false;document.querySelector('.terminal-screen')?.scrollIntoView({block:'center'});e.focus();return document.activeElement===e})()")),"Terminal focus unavailable");
        // The static native-key probe reproduced loss before the first DOM keydown.
        // Wait for rendered focus, then observe each native character at the real socket.
        // The observer neither injects data nor retries a missing character/command.
        String command="printf '%s\\n' "+marker+" | tee -a "+filename;
        renderedFocus();
        require("true".equals(js("(()=>{if(window.__seqivoNativeInput)return false;const oldStackLimit=Error.stackTraceLimit;Error.stackTraceLimit=40;const original=WebSocket.prototype.send,state={sent:'',frames:0,sends:[],replies:[],keys:[],attempt:null},listeners=new Map();const key=e=>{if(state.keys.length<500)state.keys.push({type:e.type,key:e.key||null,keyCode:e.keyCode??null,charCode:e.charCode??null,composed:e.composed,isComposing:e.isComposing??null,time:e.timeStamp,inputType:e.inputType||null,data:e.data||null,terminal:e.target===document.querySelector('.xterm-helper-textarea'),trusted:e.isTrusted})};for(const t of ['keydown','keypress','keyup','beforeinput','input'])document.addEventListener(t,key,true);const wrapped=function(data){let f;try{f=JSON.parse(data)}catch{}if(f?.v===1&&f.type==='input'){if(!listeners.has(this)){const l=e=>{try{const r=JSON.parse(e.data);if(r.type==='inputAck')state.replies.push({type:r.type,seq:r.seq,epoch:r.epoch,status:r.status});else if(r.type==='error')state.replies.push({type:r.type,code:r.code,message:r.message})}catch{}};listeners.set(this,l);this.addEventListener('message',l)}const result=original.call(this,data);state.sent+=atob(f.data);state.frames++;state.sends.push({seq:f.seq,epoch:f.epoch,data:atob(f.data),stack:new Error().stack?.split('\\n').slice(1,32)});return result}return original.call(this,data)};state.remove=()=>{Error.stackTraceLimit=oldStackLimit;for(const t of ['keydown','keypress','keyup','beforeinput','input'])document.removeEventListener(t,key,true);for(const [ws,l] of listeners)ws.removeEventListener('message',l);if(WebSocket.prototype.send!==wrapped)return false;WebSocket.prototype.send=original;delete window.__seqivoNativeInput;return true};WebSocket.prototype.send=wrapped;window.__seqivoNativeInput=state;return true})()")),"Native input observer already active");
        try {
            for(int i=0;i<command.length();i++) {
                js("window.__seqivoNativeInput.attempt="+i);
                require("true".equals(js("document.activeElement===document.querySelector('.xterm-helper-textarea')")),"Terminal keyboard focus changed");
                sendStringSync(String.valueOf(command.charAt(i)));
                String prefix=JSONObject.quote(command.substring(0,i+1));
                long end=SystemClock.elapsedRealtime()+10000;
                String acknowledged="(()=>{const s=window.__seqivoNativeInput,last=s.sends.at(-1);return s.sent==="+prefix+"&&last&&s.replies.some(r=>r.type==='inputAck'&&r.seq===last.seq&&r.epoch===last.epoch&&r.status==='written')})()";
                while(!"true".equals(js(acknowledged))) {
                    require("false".equals(js("window.__seqivoNativeInput.replies.some(r=>r.type==='error')")),"Terminal rejected input; no following keys or Enter allowed");
                    require(SystemClock.elapsedRealtime()<end,"Native character did not match real terminal input");
                    SystemClock.sleep(30);
                }
                renderedFocus();
            }
            require("true".equals(js("document.activeElement===document.querySelector('.xterm-helper-textarea') && document.querySelector('.terminal-state')?.textContent==='已连接' && [...document.querySelectorAll('.terminal-keys button')].some(x=>x.textContent==='Ctrl+C'&&!x.disabled) && !window.__seqivoNativeInput.replies.some(r=>r.type==='error')")),"Terminal lost input authority before Enter");
            sendKeyDownUpSync(KeyEvent.KEYCODE_ENTER);
            waitJs("(()=>{const s=window.__seqivoNativeInput,last=s.sends.at(-1);return s.sent==="+JSONObject.quote(command+"\r")+"&&last&&s.replies.some(r=>r.type==='inputAck'&&r.seq===last.seq&&r.epoch===last.epoch&&r.status==='written')})()");
        } catch (Throwable failure) {
            // Only fixed harness messages enter this diagnostic; never log arbitrary exceptions.
            String reason=failure instanceof AssertionError?failure.getMessage():null;
            if (reason!=null && (reason.equals("Terminal keyboard focus changed") || reason.equals("Terminal rejected input; no following keys or Enter allowed") || reason.equals("Native character did not match real terminal input") || reason.equals("Terminal lost input authority before Enter")))
                js("window.__seqivoNativeInput.failure="+JSONObject.quote(reason));
            throw failure;
        } finally {
            try {
                String observed=js("(()=>{const s=window.__seqivoNativeInput;return {sent:s.sent,sends:s.sends,replies:s.replies,keys:s.keys,attempt:s.attempt,failure:s.failure||null,terminalFocused:document.activeElement===document.querySelector('.xterm-helper-textarea'),activeTag:document.activeElement?.tagName||null,connection:document.querySelector('.terminal-state')?.textContent||null}})()");
                Files.write(new File(getTargetContext().getFilesDir(),"seqivo-command-"+marker+".json").toPath(),observed.getBytes(StandardCharsets.UTF_8));
            } finally {
                require("true".equals(js("window.__seqivoNativeInput?.remove()===true")),"Native input observer cleanup failed");
            }
        }
        // Managed tmux panes relay a separately supervised Shell. It has no
        // meaningful TMUX_PANE environment variable. The host observer must
        // independently bind each marker/file to the original pane identities.
        waitJs("[...document.querySelectorAll('.xterm-rows > div')].some(x=>x.textContent.trim()==="+JSONObject.quote(marker)+")");
        checks.put("native_key_input_output_"+marker);
    }
    private void renderedFocus() throws Exception {
        CountDownLatch drawn=new CountDownLatch(1);
        runOnMainSync(()->web().postVisualStateCallback(SystemClock.uptimeMillis(),new WebView.VisualStateCallback(){@Override public void onComplete(long id){web().postOnAnimation(()->web().postOnAnimation(drawn::countDown));web().invalidate();}}));
        require(drawn.await(8,TimeUnit.SECONDS),"Rendered terminal focus not confirmed");
    }
    private void confirmedDisconnect() throws Exception {
        tapElement(visibleButton("断开"));
        waitJs("document.querySelector('.terminal-state')?.textContent==='已断开' && document.querySelector('.terminal-actions [role=status]')?.textContent==='已断开终端，tmux 会话仍在电脑上运行。'");
    }
    private void reconnectTerminal(String name) throws Exception {
        confirmedDisconnect();
        tapElement(visibleButton("连接终端"));terminalReady(name);
    }
    private void terminalFlow() throws Exception {
        require(fixture.optBoolean("allowTerminalWrites"),"Terminal fixture authorization required");
        require(fixture.optBoolean("terminalServerEmpty")&&fixture.optLong("terminalPreflightAt")>System.currentTimeMillis()-60000,"Fresh owner-side empty-server preflight required");
        String a="APP204-A",b="APP204-B";
        openTerminal();step="terminal-approved-target";
        String target=JSONObject.quote(fixture.getString("expectedTerminalTarget"));
        require(fixture.getString("expectedTerminalTarget").endsWith("/app203-terminal"),"Unexpected terminal fixture profile");
        waitJs("document.querySelector('.terminal-target-label select')?.value==="+target+" && [...document.querySelector('.terminal-target-label select').options].filter(o=>o.value==="+target+").length===1");
        require("true".equals(js("[...document.querySelectorAll('.terminal-mode input')].every(x=>!x.checked)")),"Expected managed writable tmux mode");
        tapElement(visibleButton("连接终端"));
        step="terminal-takeover";
        tapElement(visibleButton("我来处理"));tapElement(visibleButton("确认停止并接管"));
        waitJs("document.querySelector('.terminal-control-heading')?.textContent.includes('由我处理')");
        openSessionDrawer();
        require("true".equals(js("document.querySelectorAll('.terminal-session-row').length===0")),"Fixture must have no existing sessions; do not replay this flow");
        step="terminal-create-a";setField(".terminal-create input",a);tapElement(visibleButton("新建并设为默认"));terminalReady(a);assertDefault(a);
        terminalAfterA(false);
    }
    private void requireABPreflight(String phase) throws Exception {
        step="terminal-existing-ab-preflight";
        long age=System.currentTimeMillis()-fixture.optLong("terminalContinuationAt", 0);
        require(fixture.optBoolean("allowTerminalWrites") && fixture.optBoolean("originalAFirstCommandAlreadyWritten") &&
                age>=0 && age<60000, "Fresh disposable A/B and original A1 host proof required");
        require(fixture.getString("expectedTerminalTarget").endsWith("/app203-terminal") &&
                fixture.getString("expectedWebEntryScript").matches("/assets/index-[A-Za-z0-9_-]+[.]js"),
                "Pinned disposable A/B target and webpage required");
        if(phase.equals("terminalrecoverbclear"))
            require(fixture.optBoolean("allowOriginalABRecovery") && fixture.optBoolean("allowOriginalBDraftDiscard"),
                    "Explicit original A/B recovery and B draft discard proof required");
        else
            require(phase.equals("terminalafterbclear") && fixture.optBoolean("allowOriginalABContinuation") &&
                    fixture.optBoolean("originalBDraftAlreadyCleared"),
                    "Explicit original A/B continuation and clean B prompt proof required");
    }
    private void pinnedABPage() throws Exception {
        step="terminal-existing-ab-web-pin";
        waitJs("new URL(document.querySelector('script[type=module][src]').src).pathname==="+
                JSONObject.quote(fixture.getString("expectedWebEntryScript")));
        step="terminal-existing-ab-target";
        String target=JSONObject.quote(fixture.getString("expectedTerminalTarget"));
        waitJs("document.querySelector('.terminal-target-label select')?.value==="+target+
                " && [...document.querySelector('.terminal-target-label select').options].filter(x=>x.value==="+target+").length===1");
    }
    private String originalABRows(boolean selecting) {
        return "(()=>{const rows=[...document.querySelectorAll('.terminal-session-row')],a=("+sessionRow("APP204-A")+"),b=("+
                sessionRow("APP204-B")+");return rows.length===2&&!!a&&!!b&&a.textContent.includes('★ 默认')&&"+
                "!b.textContent.includes('★ 默认')&&rows.filter(x=>x.textContent.includes('★ 默认')).length===1"+
                (selecting?"&&a.textContent.includes('已可操作')&&b.textContent.includes('已可操作')":"")+"})()";
    }
    private void terminalRecoverBClear() throws Exception {
        // requireABPreflight ran before Activity launch; keep the method safe for direct calls.
        requireABPreflight("terminalrecoverbclear");
        openTerminal();pinnedABPage();
        step="terminal-existing-ab-recovery-connect";tapElement(visibleButton("连接终端"));
        step="terminal-existing-ab-control-wait";
        waitJs("Boolean(document.querySelector('.terminal-state-control_wait')) && Boolean("+
                visibleButton("核对并恢复本设备执行权")+")");
        require("true".equals(js("document.querySelectorAll('.terminal-keys button').length>0 && [...document.querySelectorAll('.terminal-keys button')].every(x=>x.disabled) && "+
                "document.querySelector('.terminal-session-bar button span')?.textContent==='会话：未选择'")),
                "Unknown control must not select default or enable input");
        step="terminal-existing-ab-recovery-request";tapElement(visibleButton("核对并恢复本设备执行权"));
        step="terminal-existing-ab-recovery-confirm";tapElement(visibleButton("确认核对并恢复"));
        step="terminal-existing-ab-recovery-rows";
        waitJs("Boolean(document.querySelector('.terminal-state-selecting')) && "+originalABRows(true));
        require("true".equals(js("document.querySelectorAll('.terminal-keys button').length>0 && [...document.querySelectorAll('.terminal-keys button')].every(x=>x.disabled) && "+
                "!document.querySelector('.terminal-create')")),
                "Recovery must keep input closed and cannot offer new session creation");
        checks.put("unknown_original_ab_recovery_requires_explicit_b_selection");
        step="terminal-existing-ab-select-b";tapElement("("+sessionRow("APP204-B")+")?.querySelector('button')");
        terminalReady("APP204-B");
        openSessionDrawer();require("true".equals(js(originalABRows(false))),"Original A/B or default changed during recovery");
        closeSessionDrawer();
        step="terminal-existing-ab-discard-b-draft";discardCurrentDraftAndDisconnect(true);
        checks.put("original_b_draft_interrupt_once_without_enter_or_command_host_prompt_proof_required");
    }
    private void terminalAfterBClear() throws Exception {
        requireABPreflight("terminalafterbclear");
        openTerminal();pinnedABPage();
        step="terminal-existing-ab-connect-default-a";tapElement(visibleButton("连接终端"));terminalReady("APP204-A");
        step="terminal-existing-ab-check-default";openSessionDrawer();
        require("true".equals(js(originalABRows(false))),"Original A/B or default changed before B continuation");
        step="terminal-existing-ab-select-b";tapElement("("+sessionRow("APP204-B")+")?.querySelector('button')");
        terminalReady("APP204-B");
        checks.put("original_a1_and_b_creation_preserved_without_replay_host_proof_required");
        terminalAfterB();
    }
    private void requireOfflinePreflight() throws Exception {
        step="terminal-offline-preflight";
        long age=System.currentTimeMillis()-fixture.optLong("terminalOfflinePreflightAt",0);
        require(fixture.optBoolean("allowTerminalWrites") && fixture.optBoolean("allowTerminalOfflineResume") &&
                fixture.optBoolean("originalABCommandsVerified") && fixture.optBoolean("originalDefaultBVerified") &&
                age>=0 && age<60000,"Fresh complete A/B and default-B host proof required");
        require(fixture.getString("expectedTerminalTarget").endsWith("/app203-terminal") &&
                fixture.getString("expectedWebEntryScript").matches("/assets/index-[A-Za-z0-9_-]+[.]js"),
                "Pinned disposable terminal profile and webpage required");
        require(fixture.getString("terminalOfflineRunId").matches("[A-Za-z0-9_-]{12,48}"),
                "Unique bounded offline run ID required");
    }
    private String originalABRowsDefaultB() {
        return "(()=>{const rows=[...document.querySelectorAll('.terminal-session-row')],a=("+sessionRow("APP204-A")+"),b=("+
                sessionRow("APP204-B")+");return rows.length===2&&!!a&&!!b&&!a.textContent.includes('★ 默认')&&"+
                "b.textContent.includes('★ 默认')&&rows.filter(x=>x.textContent.includes('★ 默认')).length===1&&"+
                "a.textContent.includes('已可操作')&&b.textContent.includes('已可操作')})()";
    }
    private void installOfflineObserver() throws Exception {
        require("true".equals(js("(()=>{if(window.__seqivoOffline)return false;const nativeSend=WebSocket.prototype.send,links=new Map(),same=(a,b)=>!!a&&!!b&&['serverName','instanceId','sessionId'].every(k=>typeof a[k]==='string'&&a[k]===b[k]);const s={nextSocketId:0,closedSocketIds:[],sentInput:0,inputAcks:0,inputFrames:[],inputOverflow:0,unknownInputCount:0,protocolReplyCounts:{},instrumentationTypedCommands:0,readyCount:0,sessionsCount:0,closeCount:0,closeCodes:[],offlineEvents:0,onlineEvents:0,lastReady:null,defaultRef:null,items:[],baseline:null};const classifyInput=f=>{let raw;try{if(typeof f.data!=='string'||f.data.length>64||!/^[A-Za-z0-9+/]*={0,2}$/.test(f.data))return {kind:'unknown',length:null};raw=atob(f.data)}catch{return {kind:'unknown',length:null}}const E=String.fromCharCode(27);let kind=null;if(raw===E+'[?1;2c')kind='DA1_XTERM';else if(raw===E+'[>0;276;0c')kind='DA2_XTERM';else if(raw===E+'[0n')kind='DSR_STATUS_OK';else if(raw===E+'[?2026;2$y')kind='DECRQM_2026_RESET';else if(raw===E+']10;rgb:e9e9/eeee/f8f8'+E+String.fromCharCode(92))kind='OSC10_FIXED_FOREGROUND';else if(raw===E+']11;rgb:1111/1919/2727'+E+String.fromCharCode(92))kind='OSC11_FIXED_BACKGROUND';else if(raw.length<=12&&raw.startsWith(E+'[')){const privateCpr=raw.charAt(2)==='?',body=raw.slice(privateCpr?3:2);if(/^[1-9][0-9]{0,2};[1-9][0-9]{0,2}R$/.test(body)){const parts=body.slice(0,-1).split(';');if(Number(parts[0])<=500&&Number(parts[1])<=500)kind=privateCpr?'DECDSR_CPR':'DSR_CPR'}}return {kind:kind||'unknown',length:raw.length}};const offline=()=>s.offlineEvents++,online=()=>s.onlineEvents++;window.addEventListener('offline',offline);window.addEventListener('online',online);const relevant=ws=>{try{return new URL(ws.url,location.href).pathname==='/api/terminal/ws'}catch{return false}};const attach=ws=>{if(links.has(ws))return;const socketId=++s.nextSocketId;const message=e=>{let f;try{f=JSON.parse(e.data)}catch{return}if(f?.v!==1)return;if(f.type==='ready'){s.readyCount++;s.lastReady={sessionRef:f.sessionRef,epoch:f.epoch,connectionId:f.connectionId,socketId}}else if(f.type==='sessions'){s.sessionsCount++;s.defaultRef=f.defaultRef;s.items=Array.isArray(f.items)?f.items.map(i=>({name:i.name,sessionRef:i.sessionRef,authorized:i.authorized===true})):[]}else if(f.type==='inputAck')s.inputAcks++};const close=e=>{s.closeCount++;s.closedSocketIds.push(socketId);if(s.closeCodes.length<16)s.closeCodes.push(e.code)};ws.addEventListener('message',message);ws.addEventListener('close',close);links.set(ws,{message,close,socketId})};const wrapped=function(data){let f;try{f=JSON.parse(data)}catch{}if(f?.v===1&&relevant(this)){attach(this);if(f.type==='input'){s.sentInput++;const c=classifyInput(f),m={class:c.kind,length:c.length,seq:Number.isSafeInteger(f.seq)?f.seq:null,epoch:Number.isSafeInteger(f.epoch)?f.epoch:null};if(c.kind==='unknown')s.unknownInputCount++;else s.protocolReplyCounts[c.kind]=(s.protocolReplyCounts[c.kind]||0)+1;if(s.inputFrames.length<128)s.inputFrames.push(m);else s.inputOverflow++}}return nativeSend.call(this,data)};s.same=same;s.report=()=>({sentInput:s.sentInput,inputAcks:s.inputAcks,inputFrames:s.inputFrames,inputOverflow:s.inputOverflow,unknownInputCount:s.unknownInputCount,protocolReplyCounts:s.protocolReplyCounts,instrumentationTypedCommands:s.instrumentationTypedCommands,readyCount:s.readyCount,sessionsCount:s.sessionsCount,closeCount:s.closeCount,closeCodes:s.closeCodes,closedSocketIds:s.closedSocketIds,offlineEvents:s.offlineEvents,onlineEvents:s.onlineEvents,lastReady:s.lastReady,defaultRef:s.defaultRef,items:s.items,baseline:s.baseline,baselineAStillSelected:same(s.lastReady?.sessionRef,s.baseline?.aRef),defaultBStillSelected:same(s.defaultRef,s.baseline?.bRef)});s.remove=()=>{window.removeEventListener('offline',offline);window.removeEventListener('online',online);for(const [ws,l] of links){ws.removeEventListener('message',l.message);ws.removeEventListener('close',l.close)}if(WebSocket.prototype.send!==wrapped)return false;WebSocket.prototype.send=nativeSend;delete window.__seqivoOffline;return true};WebSocket.prototype.send=wrapped;window.__seqivoOffline=s;return true})()")),"Offline observer already active");
    }
    private void writeOfflineSnapshot(File file,String stage) throws Exception {
        JSONObject snapshot=new JSONObject(js("window.__seqivoOffline.report()"));
        snapshot.put("stage",stage);
        Files.write(file.toPath(),snapshot.toString(2).getBytes(StandardCharsets.UTF_8));
    }
    private void terminalResumeOffline() throws Exception {
        // One instrumentation invocation owns one Activity/WebView across the
        // external network cycle. A second startActivitySync could stack a new
        // Activity and falsely appear to recover the original connection.
        requireOfflinePreflight();
        String runId=fixture.getString("terminalOfflineRunId");
        File ready=new File(getTargetContext().getFilesDir(),"seqivo-terminal-offline-"+runId+"-ready.json");
        File proceed=new File(getTargetContext().getFilesDir(),"seqivo-terminal-offline-"+runId+"-continue");
        File result=new File(getTargetContext().getFilesDir(),"seqivo-terminal-offline-"+runId+"-result.json");
        File automatic=new File(getTargetContext().getFilesDir(),"seqivo-terminal-offline-"+runId+"-automatic.json");
        require(!ready.exists()&&!proceed.exists()&&!result.exists()&&!automatic.exists(),"Offline run ID already used; never replay an ambiguous run");
        openTerminal();pinnedABPage();installOfflineObserver();
        try {
            step="terminal-offline-connect-default-b";
            tapElement(visibleButton("连接终端"));terminalReady("APP204-B");
            openSessionDrawer();require("true".equals(js(originalABRowsDefaultB())),"Expected exact authorized A/B with default B");
            step="terminal-offline-temporary-select-a";
            tapElement("("+sessionRow("APP204-A")+")?.querySelector('button')");terminalReady("APP204-A");
            openSessionDrawer();require("true".equals(js(originalABRowsDefaultB())),"Temporary A selection changed original default B");
            closeSessionDrawer();
            require("true".equals(js("(()=>{const s=window.__seqivoOffline,a=s.items.find(x=>x.name==='APP204-A'),b=s.items.find(x=>x.name==='APP204-B');if(s.items.length!==2||!a?.authorized||!b?.authorized||!s.same(s.lastReady?.sessionRef,a.sessionRef)||!s.same(s.defaultRef,b.sessionRef)||s.unknownInputCount!==0||s.inputOverflow!==0||s.inputFrames.length!==s.sentInput||!Number.isInteger(s.lastReady?.socketId)||typeof s.lastReady?.connectionId!=='string'||!s.lastReady.connectionId)return false;s.baseline={aRef:a.sessionRef,bRef:b.sessionRef,socketId:s.lastReady.socketId,connectionId:s.lastReady.connectionId,readyCount:s.readyCount,sessionsCount:s.sessionsCount};return true})()")),"Precise A/B baseline or classified-input check failed");
            step="terminal-offline-external-network-window";
            writeOfflineSnapshot(ready,"ready_for_root_network_cycle");
            long deadline=SystemClock.elapsedRealtime()+240000;
            while(!proceed.exists()&&SystemClock.elapsedRealtime()<deadline)SystemClock.sleep(250);
            require(proceed.exists(),"Root network-return signal not received within four minutes");
            AtomicReference<Boolean> sameActivity=new AtomicReference<>(false);
            runOnMainSync(()->sameActivity.set(!activity.isDestroyed()&&!activity.isFinishing()&&activity.hasWindowFocus()));
            require(sameActivity.get(),"Original Activity did not regain foreground focus");
            step="terminal-offline-passive-original-a-recovery";
            String recovered="(()=>{const s=window.__seqivoOffline;return navigator.onLine&&s.baseline&&"+
                    "(s.offlineEvents>0||s.closeCount>0)&&s.readyCount>s.baseline.readyCount&&"+
                    "s.sessionsCount>s.baseline.sessionsCount&&s.lastReady?.socketId!==s.baseline.socketId&&s.lastReady?.connectionId!==s.baseline.connectionId&&s.closedSocketIds.includes(s.baseline.socketId)&&s.same(s.lastReady?.sessionRef,s.baseline.aRef)&&"+
                    "s.same(s.defaultRef,s.baseline.bRef)&&s.unknownInputCount===0&&s.inputOverflow===0&&s.inputFrames.length===s.sentInput&&"+
                    "document.querySelector('.terminal-state')?.textContent==='已连接'&&"+
                    "document.querySelector('.terminal-session-bar button span')?.textContent==='会话：APP204-A'&&"+
                    "[...document.querySelectorAll('.terminal-keys button')].some(x=>x.textContent==='Ctrl+C'&&!x.disabled)})()";
            long recoveredBy=SystemClock.elapsedRealtime()+120000;
            while(!"true".equals(js(recovered))&&SystemClock.elapsedRealtime()<recoveredBy)SystemClock.sleep(300);
            require("true".equals(js(recovered)),"Original A did not automatically recover with no input replay");
            openSessionDrawer();require("true".equals(js(originalABRowsDefaultB())),"Recovered A changed the default or authorized A/B");
            closeSessionDrawer();writeOfflineSnapshot(automatic,"automatic_original_a_recovered");
            checks.put("offline_return_auto_recovers_exact_a_without_terminal_input");
            step="terminal-offline-explicit-reconnect-default-b";
            confirmedDisconnect();tapElement(visibleButton("连接终端"));terminalReady("APP204-B");
            openSessionDrawer();require("true".equals(js(originalABRowsDefaultB())),"Fresh connection did not retain default B");
            closeSessionDrawer();
            require("true".equals(js("(()=>{const s=window.__seqivoOffline;return s.same(s.lastReady?.sessionRef,s.baseline?.bRef)&&s.same(s.defaultRef,s.baseline?.bRef)&&s.unknownInputCount===0&&s.inputOverflow===0&&s.inputFrames.length===s.sentInput})()")),"Fresh connection changed exact B identity or sent unclassified input");
            confirmedDisconnect();writeOfflineSnapshot(result,"explicit_reconnect_restored_default_b");
            checks.put("explicit_new_connection_restores_exact_default_b_without_terminal_input");
        } finally {
            try {writeOfflineSnapshot(result,"final_observation_at_"+step);} finally {
                require("true".equals(js("window.__seqivoOffline?.remove()===true")),"Offline observer cleanup failed");
            }
        }
    }
    private void terminalResume() throws Exception {
        require(fixture.optBoolean("allowTerminalWrites")&&fixture.optBoolean("allowOriginalAContinuation")&&fixture.optBoolean("originalDraftAlreadyCleared")&&fixture.optLong("terminalContinuationAt")>System.currentTimeMillis()-60000,"Fresh original-A identity and clean-prompt preflight required");
        require(fixture.optLong("terminalContinuationAt")<=System.currentTimeMillis(),"Future continuation proof is invalid");
        if(arguments.getString("phase", "").equals("terminalrecovera1"))
            require(fixture.optBoolean("allowOriginalRecovery") && fixture.optBoolean("originalAFirstCommandAlreadyWritten"),"Explicit original unknown-state recovery proof required");
        openTerminal();step="terminal-original-a-web-pin";
        require(fixture.getString("expectedWebEntryScript").matches("/assets/index-[A-Za-z0-9_-]+[.]js"),"Pinned resume webpage script required");
        waitJs("new URL(document.querySelector('script[type=module][src]').src).pathname==="+JSONObject.quote(fixture.getString("expectedWebEntryScript")));
        step="terminal-original-a-target";
        String target=JSONObject.quote(fixture.getString("expectedTerminalTarget"));
        require(fixture.getString("expectedTerminalTarget").endsWith("/app203-terminal"),"Unexpected terminal fixture profile");
        waitJs("document.querySelector('.terminal-target-label select')?.value==="+target);
        step="terminal-original-a-native-connect";tapElement(visibleButton("连接终端"));
        if(arguments.getString("phase", "").equals("terminalrecovera1")) {
            step="terminal-original-a-recovery-gate";
            waitJs("Boolean(document.querySelector('.terminal-state-control_wait')) && Boolean("+visibleButton("核对并恢复本设备执行权")+")");
            require("true".equals(js("[...document.querySelectorAll('.terminal-keys button')].every(x=>x.disabled) && document.querySelector('.terminal-session-bar button span')?.textContent==='会话：未选择'")),"Unknown control must not open default or allow input");
            tapElement(visibleButton("核对并恢复本设备执行权"));
            step="terminal-original-a-explicit-reconcile";tapElement(visibleButton("确认核对并恢复"));
            waitJs("Boolean(document.querySelector('.terminal-state-selecting')) && document.querySelectorAll('.terminal-session-row').length===1 && Boolean(("+sessionRow("APP204-A")+")?.textContent.includes('已可操作'))");
            require("true".equals(js("[...document.querySelectorAll('.terminal-keys button')].every(x=>x.disabled) && !document.querySelector('.terminal-create')")),"Recovery must wait for explicit original session selection");
            checks.put("unknown_same_device_recovery_keeps_input_closed_until_original_selection");
            step="terminal-original-a-explicit-select";tapElement("("+sessionRow("APP204-A")+")?.querySelector('button')");
        }
        step="terminal-original-a-wait-ready";terminalReady("APP204-A");
        step="terminal-original-a-drawer";openSessionDrawer();
        require("true".equals(js("document.querySelectorAll('.terminal-session-row').length===1 && Boolean(("+sessionRow("APP204-A")+")?.textContent.includes('★ 默认'))")),"Original A must remain the only session and default");
        closeSessionDrawer();
        // The previous native Ctrl+C cleared the draft, but this Shell does not
        // echo ^C. Require the host's precise idle-shell/fresh-prompt proof;
        // do not repeat the interrupt or look for stale scrollback text.
        checks.put("original_a_reconnected_after_owner_confirmed_idle_prompt");
        if(arguments.getString("phase", "").equals("terminalconnect")) {
            step="terminal-original-a-probe-disconnect";confirmedDisconnect();
            checks.put("original_a_connected_without_input");return;
        }
        boolean afterA1=(arguments.getString("phase", "").equals("terminalaftera1") || arguments.getString("phase", "").equals("terminalrecovera1"));
        if(afterA1)require(fixture.optBoolean("originalAFirstCommandAlreadyWritten"),"Host proof of original A1 write required; do not replay");
        terminalAfterA(afterA1);
    }
    private void terminalAfterA(boolean skipFirstCommand) throws Exception {
        String a="APP204-A",b="APP204-B";
        if(!skipFirstCommand)terminalCommand("APP204_A1","app204-a1.txt");
        else checks.put("original_a1_preserved_without_replay_host_file_proof_required");
        step="terminal-create-b";openSessionDrawer();setField(".terminal-create input",b);tapElement(visibleButton("新建并连接"));terminalReady(b);assertDefault(a);
        terminalAfterB();
    }
    private void terminalAfterB() throws Exception {
        String a="APP204-A",b="APP204-B";
        terminalCommand("APP204_B1","app204-b1.txt");
        step="terminal-temporary-switch";openSessionDrawer();tapElement("("+sessionRow(a)+")?.querySelector('button')");terminalReady(a);
        openSessionDrawer();tapElement("("+sessionRow(b)+")?.querySelector('button')");terminalReady(b);assertDefault(a);
        step="terminal-reconnect-default-a";reconnectTerminal(a);terminalCommand("APP204_A2","app204-a2.txt");
        checks.put("temporary_b_does_not_change_default_a_after_reconnect");
        step="terminal-set-default-b";openSessionDrawer();tapElement("("+sessionRow(b)+")?.querySelector('.terminal-default-button')");
        waitJs("Boolean(("+sessionRow(b)+")?.textContent.includes('★ 默认'))");closeSessionDrawer();
        step="terminal-reconnect-default-b";reconnectTerminal(b);terminalCommand("APP204_B2","app204-b2.txt");assertDefault(b);
        checks.put("explicit_default_b_restored_on_new_connection");
        step="terminal-final-disconnect";confirmedDisconnect();
        checks.put("terminal_disconnected_through_native_pointer");
    }

    private void terminalClearFixture() throws Exception {
        require(fixture.optBoolean("allowOriginalDraftDiscard")&&fixture.optLong("terminalTraceAt")>System.currentTimeMillis()-60000,"Fresh exact-idle-shell draft preflight required");
        openTerminal();step="terminal-discard-scoped-fixture-draft";
        require(fixture.getString("expectedWebEntryScript").matches("/assets/index-[A-Za-z0-9_-]+[.]js"),"Pinned discard webpage script required");
        waitJs("new URL(document.querySelector('script[type=module][src]').src).pathname==="+JSONObject.quote(fixture.getString("expectedWebEntryScript")));
        waitJs("document.querySelector('.terminal-target-label select')?.value==="+JSONObject.quote(fixture.getString("expectedTerminalTarget")));
        tapElement(visibleButton("连接终端"));terminalReady("APP204-A");
        discardCurrentDraftAndDisconnect(false);
    }
    private void discardCurrentDraftAndDisconnect(boolean exactSingleInterrupt) throws Exception {
        require("true".equals(js("(()=>{if(window.__seqivoDiscard)return false;const original=WebSocket.prototype.send,s={sends:[],replies:[],clicks:0},listeners=new Map();const click=e=>{if(e.target.closest('button')?.textContent==='Ctrl+C'&&e.isTrusted)s.clicks++};document.addEventListener('click',click,true);const wrapped=function(data){let f;try{f=JSON.parse(data)}catch{}if(f?.v===1&&f.type==='input'){if(!listeners.has(this)){const l=e=>{try{const r=JSON.parse(e.data);if(r.type==='inputAck')s.replies.push({type:r.type,seq:r.seq,epoch:r.epoch,status:r.status});else if(r.type==='error')s.replies.push({type:r.type,code:r.code})}catch{}};listeners.set(this,l);this.addEventListener('message',l)}s.sends.push({seq:f.seq,epoch:f.epoch,isInterrupt:atob(f.data)===String.fromCharCode(3),bytes:atob(f.data).length})}return original.call(this,data)};s.remove=()=>{document.removeEventListener('click',click,true);for(const [ws,l] of listeners)ws.removeEventListener('message',l);if(WebSocket.prototype.send!==wrapped)return false;WebSocket.prototype.send=original;delete window.__seqivoDiscard;return true};WebSocket.prototype.send=wrapped;window.__seqivoDiscard=s;return true})()")),"Discard observer already active");
        try {
            tapElement(visibleButton("Ctrl+C"));
            long end=SystemClock.elapsedRealtime()+10000;
            String ack="(()=>{const s=window.__seqivoDiscard,f=s.sends.find(f=>f.isInterrupt);return s.clicks===1&&f&&s.sends.filter(x=>x.isInterrupt).length===1&&"+
                    (exactSingleInterrupt?"s.sends.length===1&&f.bytes===1&&":"")+
                    "s.replies.some(r=>r.type==='inputAck'&&r.seq===f.seq&&r.epoch===f.epoch&&r.status==='written')&&!s.replies.some(r=>r.type==='error')})()";
            while(!"true".equals(js(ack))&&SystemClock.elapsedRealtime()<end)SystemClock.sleep(50);
            require("true".equals(js(ack)),"Native discard click or interrupt acknowledgement missing");
            SystemClock.sleep(500);
            confirmedDisconnect();
            if(exactSingleInterrupt)require("true".equals(js("window.__seqivoDiscard.sends.length===1 && window.__seqivoDiscard.sends[0].isInterrupt && window.__seqivoDiscard.sends[0].bytes===1")),"Additional terminal input during B draft discard");
            checks.put("native_discard_click_and_written_ack_observed_host_must_confirm_idle_prompt");
        } finally {
            try {
                String value=js("(()=>{const s=window.__seqivoDiscard;return {sends:s.sends,replies:s.replies,clicks:s.clicks,connection:document.querySelector('.terminal-state')?.textContent||null}})()");
                Files.write(new File(getTargetContext().getFilesDir(),"seqivo-terminal-discard.json").toPath(),value.getBytes(StandardCharsets.UTF_8));
            } finally { require("true".equals(js("window.__seqivoDiscard?.remove()===true")),"Discard observer cleanup failed"); }
        }
    }

    private void terminalViewport() throws Exception {
        require(fixture.optBoolean("allowTerminalViewport"),"Disposable terminal viewport authorization required");
        openTerminal();step="terminal-viewport-connect";
        require(fixture.getString("expectedWebEntryScript").matches("/assets/index-[A-Za-z0-9_-]+[.]js"),"Pinned webpage script required");
        waitJs("new URL(document.querySelector('script[type=module][src]').src).pathname==="+JSONObject.quote(fixture.getString("expectedWebEntryScript")));
        waitJs("document.querySelector('.terminal-target-label select')?.value==="+JSONObject.quote(fixture.getString("expectedTerminalTarget")));
        tapElement(visibleButton("连接终端"));terminalReady("APP204-A");
        step="terminal-viewport-native-ime";
        require("true".equals(js("(()=>{const e=document.querySelector('.xterm-helper-textarea');e.focus();return document.activeElement===e})()")),"Terminal focus unavailable");
        runOnMainSync(()->{
            WebView view=web();view.requestFocus();
            ((android.view.inputmethod.InputMethodManager)activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE)).showSoftInput(view,android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);
        });
        long end=SystemClock.elapsedRealtime()+5000;
        AtomicReference<Boolean> ime=new AtomicReference<>(false);
        do { runOnMainSync(()->ime.set(web().getRootWindowInsets()!=null&&web().getRootWindowInsets().isVisible(android.view.WindowInsets.Type.ime()))); if(ime.get())break;SystemClock.sleep(100); }while(SystemClock.elapsedRealtime()<end);
        require(ime.get(),"Actual Android IME not visible");
        renderedFocus();SystemClock.sleep(400);
        String measure="(()=>{const box=s=>{const r=document.querySelector(s)?.getBoundingClientRect();return r?{top:r.top,bottom:r.bottom,height:r.height}:null};const v=visualViewport;return {screen:box('.terminal-screen'),keys:box('.terminal-keys'),session:box('.terminal-session-bar'),nav:box('.mobile-nav'),top:v.offsetTop,bottom:v.offsetTop+v.height,height:v.height,innerHeight,focused:document.activeElement===document.querySelector('.xterm-helper-textarea')}})()";
        JSONObject keyboard=new JSONObject(js(measure));
        boolean visible=keyboard.getJSONObject("screen").getDouble("top")>=keyboard.getDouble("top")-2
            &&keyboard.getJSONObject("screen").getDouble("bottom")<=keyboard.getJSONObject("keys").getDouble("top")
            &&keyboard.getJSONObject("keys").getDouble("bottom")<=keyboard.getJSONObject("session").getDouble("top")+2
            &&keyboard.getJSONObject("session").getDouble("bottom")<=keyboard.getDouble("bottom")+2
            &&keyboard.getJSONObject("nav").getDouble("bottom")<=keyboard.getDouble("bottom")+2;
        JSONObject diagnostic=new JSONObject().put("actualAndroidImeVisible",true).put("keyboard",keyboard).put("controlsVisible",visible);
        Files.write(new File(getTargetContext().getFilesDir(),"seqivo-terminal-viewport.json").toPath(),diagnostic.toString().getBytes(StandardCharsets.UTF_8));
        require(visible,"Actual IME obscures terminal controls");
        runOnMainSync(()->((android.view.inputmethod.InputMethodManager)activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(web().getWindowToken(),0));
        SystemClock.sleep(400);renderedFocus();
        JSONObject restored=new JSONObject(js(measure));diagnostic.put("restored",restored);
        Files.write(new File(getTargetContext().getFilesDir(),"seqivo-terminal-viewport.json").toPath(),diagnostic.toString().getBytes(StandardCharsets.UTF_8));
        require(restored.getDouble("height")>keyboard.getDouble("height"),"IME close did not restore viewport");
        confirmedDisconnect();checks.put("actual_android_ime_keeps_terminal_and_session_controls_visible");
    }

    private void terminalInputTrace() throws Exception {
        require(fixture.optBoolean("allowTerminalWrites")&&fixture.optBoolean("allowNoEnterInputTrace"),"Disposable no-Enter trace authorization required");
        require(fixture.optLong("terminalTraceAt")>System.currentTimeMillis()-60000,"Fresh original-session trace preflight required");
        openTerminal();step="terminal-input-trace-connect";
        require(fixture.getString("expectedWebEntryScript").matches("/assets/index-[A-Za-z0-9_-]+[.]js"),"Pinned trace webpage script required");
        waitJs("new URL(document.querySelector('script[type=module][src]').src).pathname==="+JSONObject.quote(fixture.getString("expectedWebEntryScript")));
        String target=JSONObject.quote(fixture.getString("expectedTerminalTarget"));
        require(fixture.getString("expectedTerminalTarget").endsWith("/app203-terminal"),"Unexpected terminal fixture profile");
        waitJs("document.querySelector('.terminal-target-label select')?.value==="+target);
        tapElement(visibleButton("连接终端"));terminalReady("APP204-A");
        require("true".equals(js("(()=>{document.querySelector('.terminal-screen').scrollIntoView({block:'center'});const e=document.querySelector('.xterm-helper-textarea');e.focus();return document.activeElement===e})()")),"Terminal focus unavailable");
        renderedFocus();
        require("true".equals(js("(()=>{if(window.__seqivoInputTrace)return false;const oldStackLimit=Error.stackTraceLimit;Error.stackTraceLimit=40;const original=WebSocket.prototype.send,s={sent:'',sends:[],replies:[],keys:[]},listeners=new Map();const key=e=>{if(s.keys.length<100)s.keys.push({type:e.type,key:e.key||null,keyCode:e.keyCode??null,charCode:e.charCode??null,which:e.which??null,composed:e.composed,isComposing:e.isComposing??null,inputType:e.inputType||null,time:e.timeStamp,data:e.data||null,trusted:e.isTrusted,terminal:e.target===document.querySelector('.xterm-helper-textarea')})};for(const t of ['keydown','keypress','keyup','beforeinput','input'])document.addEventListener(t,key,true);const wrapped=function(data){let f;try{f=JSON.parse(data)}catch{}if(f?.v===1&&f.type==='input'){if(!listeners.has(this)){const l=e=>{try{const r=JSON.parse(e.data);if(r.type==='inputAck')s.replies.push({type:r.type,seq:r.seq,epoch:r.epoch,status:r.status});else if(r.type==='error')s.replies.push({type:r.type,code:r.code})}catch{}};listeners.set(this,l);this.addEventListener('message',l)}const result=original.call(this,data);s.sent+=atob(f.data);s.sends.push({seq:f.seq,epoch:f.epoch,data:atob(f.data),stack:new Error().stack?.split('\\n').slice(1,32)});return result}return original.call(this,data)};s.remove=()=>{Error.stackTraceLimit=oldStackLimit;for(const t of ['keydown','keypress','keyup','beforeinput','input'])document.removeEventListener(t,key,true);for(const [socket,l] of listeners)socket.removeEventListener('message',l);if(WebSocket.prototype.send!==wrapped)return false;WebSocket.prototype.send=original;delete window.__seqivoInputTrace;return true};WebSocket.prototype.send=wrapped;window.__seqivoInputTrace=s;return true})()")),"Trace already active");
        JSONObject diagnostic=new JSONObject();String sample="printf '%s\\n' APP";
        try {
            step="terminal-input-trace-no-enter";
            for(int i=0;i<sample.length();i++) {
                require("true".equals(js("document.activeElement===document.querySelector('.xterm-helper-textarea') && document.querySelector('.terminal-state')?.textContent==='已连接' && !window.__seqivoInputTrace.replies.some(r=>r.type==='error')")),"Trace lost terminal focus or input authority");
                sendStringSync(String.valueOf(sample.charAt(i)));
                String prefix=JSONObject.quote(sample.substring(0,i+1));
                long end=SystemClock.elapsedRealtime()+3000;
                String condition="(()=>{const s=window.__seqivoInputTrace,last=s.sends.at(-1);return s.sent==="+prefix+"&&last&&s.replies.some(r=>r.type==='inputAck'&&r.seq===last.seq&&r.epoch===last.epoch&&r.status==='written')})()";
                while(!"true".equals(js(condition))&&SystemClock.elapsedRealtime()<end)SystemClock.sleep(50);
                if(!"true".equals(js(condition))||"true".equals(js("window.__seqivoInputTrace.replies.some(r=>r.type==='error')"))) {
                    diagnostic.put("stoppedAtIndex",i);break;
                }
                renderedFocus();
            }
            SystemClock.sleep(300);
            diagnostic.put("sample",sample).put("enterSent",false).put("trace",new JSONObject(js("(()=>{const s=window.__seqivoInputTrace;return {sent:s.sent,sends:s.sends,replies:s.replies,keys:s.keys}})()")));
        } finally {
            diagnostic.put("cleanup", "true".equals(js("window.__seqivoInputTrace?.remove()===true")));
            Files.write(new File(getTargetContext().getFilesDir(),"seqivo-terminal-input-trace.json").toPath(),diagnostic.toString().getBytes(StandardCharsets.UTF_8));
        }
        require(diagnostic.optBoolean("cleanup"),"Trace cleanup failed");
        checks.put("native_input_trace_recorded_without_enter_not_terminal_acceptance");
    }

    private void setField(String selector, String value) throws Exception {
        require("true".equals(js("(()=>{const e=document.querySelector("+JSONObject.quote(selector)+");if(!e)return false;const p=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,"+JSONObject.quote(value)+");e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()")), "Form field unavailable");
    }

    private WebView web() { WebView view=find(activity.getWindow().getDecorView(),WebView.class,null); require(view!=null,"WebView unavailable"); return view; }
    private String js(String script) throws Exception {
        CountDownLatch done=new CountDownLatch(1); AtomicReference<String> result=new AtomicReference<>(); AtomicReference<Throwable> error=new AtomicReference<>();
        runOnMainSync(()->{try{
            WebView view=web();
            String url=view.getUrl();
            if(url==null||url.equals("about:blank")){result.set("false");done.countDown();return;}
            URI actual=URI.create(url),expected=URI.create(fixture.optString("origin"));
            int actualPort=actual.getPort()<0?443:actual.getPort(),expectedPort=expected.getPort()<0?443:expected.getPort();
            require("https".equals(actual.getScheme())&&actual.getUserInfo()==null&&
                    expected.getHost().equalsIgnoreCase(actual.getHost())&&actualPort==expectedPort,
                    "Actual WebView origin differs from the disposable fixture");
            view.evaluateJavascript(script,value->{result.set(value);done.countDown();});
        }catch(Throwable problem){error.set(problem);done.countDown();}});
        require(done.await(8,TimeUnit.SECONDS),"WebView response timed out");
        if(error.get()!=null)throw new AssertionError("WebView unavailable");
        return result.get();
    }
    private void waitJs(String expression) throws Exception {
        long end=SystemClock.elapsedRealtime()+45000;
        do { if("true".equals(js(expression)))return; SystemClock.sleep(200); } while(SystemClock.elapsedRealtime()<end);
        throw new AssertionError("Page condition timed out");
    }
    private void writeReport(JSONObject report) throws Exception {
        Files.write(new File(getTargetContext().getFilesDir(),"seqivo-acceptance-result.json").toPath(),report.toString(2).getBytes(StandardCharsets.UTF_8));
    }
    private static void require(boolean value,String message) { if(!value)throw new AssertionError(message); }
    private static <T extends View> T find(View root,Class<T> type,String text) {
        if(type.isInstance(root)&&(text==null||root instanceof Button&&text.equals(((Button)root).getText().toString())))return type.cast(root);
        if(root instanceof ViewGroup){ViewGroup group=(ViewGroup)root;for(int i=0;i<group.getChildCount();i++){T found=find(group.getChildAt(i),type,text);if(found!=null)return found;}}
        return null;
    }
}
