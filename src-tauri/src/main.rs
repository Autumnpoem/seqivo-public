#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{collections::HashMap, path::PathBuf, sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}}, time::Duration};
use serde_json::{Value,json};
use tauri::{Manager,Emitter,State,WebviewWindowBuilder,WebviewUrl,menu::{Menu,MenuItem,MenuItemKind},tray::TrayIconBuilder};
use tauri_plugin_shell::{ShellExt,process::{CommandChild,CommandEvent}};
use tauri_plugin_dialog::{DialogExt,MessageDialogButtons,MessageDialogKind};
use tokio::sync::oneshot;
mod shutdown;
mod startup;
use shutdown::{Shutdown,Phase,Issue};
use startup::{Startup,Phase as StartupPhase};

type Reply=oneshot::Sender<Result<Value,String>>;
struct Backend { child:Mutex<Option<CommandChild>>, pending:Mutex<HashMap<String,Reply>>, startup:Mutex<Startup>, shutdown:Mutex<Shutdown>, shutdown_dialog:AtomicBool }
const BRIDGE:&str=include_str!("bridge.js");
// A diagnostic threshold, not permission to kill the service. The built-in
// provider can spend 60s in its close RPC, then 10s in owned process cleanup.
const SHUTDOWN_NOTICE_AFTER:Duration=Duration::from_secs(75);

fn startup_snapshot(state:&Startup)->Value {
  let phase=match state.phase(){StartupPhase::Starting=>"starting",StartupPhase::Ready=>"ready",StartupPhase::Failed=>"failed",StartupPhase::Stopping=>"stopping"};
  json!({"phase":phase,"revision":state.revision(),"message":state.message()})
}
fn observe_startup(app:&tauri::AppHandle,backend:&Arc<Backend>,change:impl FnOnce(&mut Startup)->bool){
  let snapshot={let mut state=backend.startup.lock().unwrap();if change(&mut state){Some(startup_snapshot(&state))}else{None}};
  if let Some(value)=snapshot{let _=app.emit("startup-status",value);}
}
#[tauri::command]
fn startup_status(state:State<'_,Arc<Backend>>)->Value {startup_snapshot(&state.startup.lock().unwrap())}

fn publish_shutdown(app:&tauri::AppHandle,backend:&Arc<Backend>){
  let displayed=backend.shutdown.lock().unwrap().snapshot();
  let (phase,issue,can_exit,exit_code)=(displayed.phase,displayed.issue,displayed.can_exit_unverified,displayed.exit_code);
  if let Some(code)=exit_code {app.exit(code);return;}
  if phase==Phase::Running{return;}
  let main_window=app.get_webview_window("main");
  if let Some(window)=&main_window{
    let _=window.set_title(if phase==Phase::Stopping{"序程 · 正在停止后台"}else{"序程 · 退出结果待核实"});
  }
  // A windowless macOS dialog uses CFUserNotification, which is not attached
  // to the application window. Wait for the main window instead.
  let Some(window)=main_window else{return;};
  if !matches!(phase,Phase::Unknown|Phase::Failed)||backend.shutdown_dialog.swap(true,Ordering::SeqCst){return;}
  show(app);
  let reason=match issue {
    Some(Issue::Delivery)=>"退出指令的送达结果尚未确认。",
    Some(Issue::Deadline)=>"后台清理仍未确认完成，等待时间已较长。",
    Some(Issue::Observation)=>"与任务服务的状态连接已中断，不能据此确认进程停止。",
    Some(Issue::MissingReceipt)=>"任务服务已退出，但没有收到完整的关闭回执。",
    Some(Issue::Process)=>"任务服务未正常关闭，部分后台任务的停止结果仍待核实。",
    None=>"后台停止结果仍待核实。",
  };
  let message=if can_exit {
    format!("{reason}\n\n可以退出界面，但这不代表 AI 已安全停止。未确认的记录会保留，下次启动需要核对。")
  }else{
    format!("{reason}\n\n序程会继续观察原退出请求，暂不接受新操作，也不会重复发送。请保留窗口等待核实。")
  };
  let handle=app.clone();let b=backend.clone();
  let buttons=if can_exit {MessageDialogButtons::OkCancelCustom("退出界面".into(),"保留窗口".into())}
    else{MessageDialogButtons::OkCustom("继续等待".into())};
  app.dialog().message(message).title("退出结果待核实").kind(MessageDialogKind::Warning).buttons(buttons).parent(&window).show(move|confirmed|{
    b.shutdown_dialog.store(false,Ordering::SeqCst);
    if can_exit&&confirmed {
      let approved=b.shutdown.lock().unwrap().confirm_unverified_exit();
      if approved{handle.exit(1);return;}
    }
    // A termination may arrive while the old "continue waiting" dialog is open.
    // Re-display only changed facts, including new eligibility to exit the UI.
    let refresh=b.shutdown.lock().unwrap().snapshot().needs_notice_after(displayed);
    if refresh{publish_shutdown(&handle,&b);}
  });
}
fn observe_shutdown(app:&tauri::AppHandle,backend:&Arc<Backend>,change:impl FnOnce(&mut Shutdown)){
  let changed={let mut state=backend.shutdown.lock().unwrap();let before=state.snapshot();change(&mut state);before!=state.snapshot()};
  if changed{publish_shutdown(app,backend);}
}
fn request_shutdown(app:&tauri::AppHandle,backend:&Arc<Backend>){
  let start=backend.shutdown.lock().unwrap().request_exit();
  observe_startup(app,backend,Startup::stopping);
  publish_shutdown(app,backend);
  if !start{return;}
  let handle=app.clone();let b=backend.clone();
  // Pipe writes can block. Neither writing nor waiting runs on the UI thread.
  std::thread::spawn(move||{
    let sent=b.child.lock().unwrap().as_mut()
      .map(|child|child.write(b"{\"event\":\"shutdown\"}\n").is_ok()).unwrap_or(false);
    if !sent{observe_shutdown(&handle,&b,Shutdown::delivery_failed);}
  });
  let handle=app.clone();let b=backend.clone();
  tauri::async_runtime::spawn(async move{
    tokio::time::sleep(SHUTDOWN_NOTICE_AFTER).await;
    observe_shutdown(&handle,&b,Shutdown::deadline_elapsed);
  });
}

#[tauri::command]
async fn api_request(method:String,path:String,body:Value,state:State<'_,Arc<Backend>>) -> Result<Value,String> {
  if !path.starts_with("/api/") {return Err("接口不允许".into());}
  let backend=state.inner().clone();
  if !backend.shutdown.lock().unwrap().accepts_requests(){return Err("序程正在关闭，暂不接受新操作；请等待关闭结果。".into());}
  for _ in 0..100 {
    {
      let startup=backend.startup.lock().unwrap();
      if let Some(error)=startup.message(){return Err(error.into());}
      if startup.phase()==StartupPhase::Ready{break;}
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
  }
  if backend.startup.lock().unwrap().phase()!=StartupPhase::Ready{return Err("任务服务尚未就绪，请稍候查看启动状态。".into());}
  let request_id=uuid::Uuid::new_v4().to_string();let (tx,rx)=oneshot::channel();
  backend.pending.lock().unwrap().insert(request_id.clone(),tx);
  let payload=format!("{}\n",json!({"id":request_id,"method":method,"path":path,"body":body}));
  let write_result=backend.child.lock().unwrap().as_mut().ok_or("任务服务未运行".to_string()).and_then(|child|{
    if !backend.shutdown.lock().unwrap().accepts_requests(){return Err("序程正在关闭，暂不接受新操作；请等待关闭结果。".into());}
    child.write(payload.as_bytes()).map_err(|e|e.to_string())
  });
  if let Err(error)=write_result {backend.pending.lock().unwrap().remove(&request_id);return Err(error);}
  match tokio::time::timeout(Duration::from_secs(90),rx).await {
    Ok(Ok(result))=>result,
    _=>{backend.pending.lock().unwrap().remove(&request_id);Err("请求结果未知，请刷新检查，勿重复触发继续任务".into())}
  }
}
fn show(app:&tauri::AppHandle){if let Some(w)=app.get_webview_window("main"){let _=w.show();let _=w.set_focus();}}
#[tauri::command]
fn show_main(app:tauri::AppHandle){show(&app);}
#[tauri::command]
fn open_floating(app:tauri::AppHandle)->Result<(),String>{
  if let Some(w)=app.get_webview_window("floating"){return w.show().map_err(|e|e.to_string());}
  WebviewWindowBuilder::new(&app,"floating",WebviewUrl::App("index.html?floating=1".into()))
    .title("序程 · 悬浮看板").inner_size(370.,320.).min_inner_size(320.,90.).always_on_top(true).focused(false)
    .initialization_script(BRIDGE).build().map_err(|e|e.to_string())?;
  Ok(())
}
#[tauri::command]
fn set_floating_compact(app:tauri::AppHandle,compact:bool)->Result<(),String>{
  if let Some(window)=app.get_webview_window("floating"){
    let width=window.inner_size().map_err(|e|e.to_string())?.width as f64/window.scale_factor().map_err(|e|e.to_string())?;
    window.set_size(tauri::LogicalSize::new(width,if compact{128.}else{320.})).map_err(|e|e.to_string())?;
  }
  Ok(())
}
#[tauri::command]
async fn choose_directory(app:tauri::AppHandle)->Result<Option<String>,String>{
  tauri::async_runtime::spawn_blocking(move||app.dialog().file().set_title("选择项目文件夹").blocking_pick_folder().map(|p|p.to_string()))
    .await.map_err(|e|e.to_string())
}
fn main(){
  let backend=Arc::new(Backend{child:Mutex::new(None),pending:Mutex::new(HashMap::new()),startup:Mutex::new(Startup::default()),shutdown:Mutex::new(Shutdown::default()),shutdown_dialog:AtomicBool::new(false)});
  let setup_backend=backend.clone();
  let app=tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app,_,_|show(app)))
    .plugin(tauri_plugin_shell::init()).plugin(tauri_plugin_dialog::init())
    .manage(backend.clone())
    .invoke_handler(tauri::generate_handler![api_request,startup_status,show_main,open_floating,set_floating_compact,choose_directory])
    .setup(move |app| {
      let resource=app.path().resource_dir()?.join("resources");
      let data=match std::env::var_os("TUIJIN_DATA_DIR").filter(|value|!value.is_empty()){
        Some(value)=>{let path=PathBuf::from(value);if !path.is_absolute(){return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput,"TUIJIN_DATA_DIR must be an absolute path").into());}path},
        None=>app.path().app_data_dir()?,
      };
      std::fs::create_dir_all(&data)?;
      #[cfg(target_os="macos")]
      {
        // Dock Quit / Quit AppleEvents do not reach Tauri's ExitRequested.
        // Tao installs this delegate selector before AppKit caches its methods.
        // Cancel the native request, then use the same receipt + process-exit
        // gate as our menu. System logout/restart may need to be retried after
        // Seqivo closes; we never allow it to bypass unfinished cleanup.
        let native_handle=app.handle().clone();let native_backend=setup_backend.clone();
        tao::platform::macos::set_application_should_terminate_handler(move||{
          request_shutdown(&native_handle,&native_backend);
        }).map_err(std::io::Error::other)?;
        // Keep the explicit safe-shutdown label and existing menu shortcut.
        // Native termination is now guarded too, but both routes use the same
        // one-shot cleanup rather than relying on applicationWillTerminate.
        // Prepare and install the menu before spawning the Rust-owned child:
        // a menu setup error must not leave an unobserved sidecar behind.
        let app_menu=Menu::default(app.handle())?;
        let application=match app_menu.items()?.into_iter().next(){
          Some(MenuItemKind::Submenu(menu))=>menu,
          _=>return Err(std::io::Error::other("macOS application menu is missing").into()),
        };
        let items=application.items()?;
        let default_quit=match items.last(){
          Some(MenuItemKind::Predefined(item)) if item.text()?.starts_with("Quit")=>item,
          _=>return Err(std::io::Error::other("macOS default Quit item changed").into()),
        };
        application.remove(default_quit)?;
        let safe_quit=MenuItem::with_id(app,"safe-quit","退出并停止后台",true,Some("CmdOrCtrl+Q"))?;
        application.append(&safe_quit)?;
        let menu_backend=setup_backend.clone();
        app.on_menu_event(move|handle,event|{
          if event.id()=="safe-quit"{request_shutdown(handle,&menu_backend);}
        });
        app.set_menu(app_menu)?;
      }
      let args=vec![resource.join("server/sidecar.mjs").to_string_lossy().into_owned(),data.to_string_lossy().into_owned(),resource.join("plugins").to_string_lossy().into_owned(),std::env::var("TUIJIN_WORKSPACE").unwrap_or_default()];
      let (mut rx,child)=app.shell().sidecar("taskboard-node")?.args(args).spawn()?;
      *setup_backend.child.lock().unwrap()=Some(child);
      let handle=app.handle().clone();let b=setup_backend.clone();
      tauri::async_runtime::spawn(async move {
        while let Some(event)=rx.recv().await {match event {
          CommandEvent::Stdout(bytes)=>{if let Ok(value)=serde_json::from_slice::<Value>(&bytes){
            if value["event"]=="ready"{observe_startup(&handle,&b,Startup::ready);}
            else if value["event"]=="startup-blocked"&&value["reason"]=="unclean_shutdown_review_required"{observe_startup(&handle,&b,Startup::unclean_shutdown);}
            else if value["event"]=="shutdown-complete"{observe_shutdown(&handle,&b,Shutdown::receipt);}
            else if value["event"]=="changed"{let _=handle.emit("board-changed",());}
            else if let Some(id)=value["id"].as_str(){if let Some(tx)=b.pending.lock().unwrap().remove(id){let result=if value.get("error").is_some(){Err(value["error"]["message"].as_str().unwrap_or("任务服务出错").to_string())}else{Ok(value["result"].clone())};let _=tx.send(result);}}
          }},
          CommandEvent::Stderr(bytes)=>eprintln!("{}",String::from_utf8_lossy(&bytes)),
          CommandEvent::Terminated(payload)=>{observe_startup(&handle,&b,|s|s.failed("任务服务已退出，请重新打开应用。"));for (_,tx) in b.pending.lock().unwrap().drain(){let _=tx.send(Err("任务服务已退出，操作结果未知".into()));}let _=handle.emit("board-changed",());observe_shutdown(&handle,&b,|state|state.terminated(payload.code,payload.signal));},
          _=>{}
        }}
        // A closed channel alone is not proof that the process exited. Keep
        // reading after Terminated so a buffered final receipt can still arrive.
        observe_startup(&handle,&b,|s|s.failed("与任务服务的状态连接已中断，停止结果仍需核实。"));
        observe_shutdown(&handle,&b,Shutdown::observation_closed);
      });
      WebviewWindowBuilder::new(app,"main",WebviewUrl::App("index.html".into())).title("序程 · AI 任务看板").inner_size(1180.,820.).min_inner_size(700.,500.).initialization_script(BRIDGE).build()?;
      let open=MenuItem::with_id(app,"open","打开序程",true,None::<&str>)?;
      let float=MenuItem::with_id(app,"float","显示悬浮窗",true,None::<&str>)?;
      let quit=MenuItem::with_id(app,"quit","退出并停止后台",true,None::<&str>)?;
      let menu=Menu::with_items(app,&[&open,&float,&quit])?;
      let tray_backend=setup_backend.clone();
      let mut tray=TrayIconBuilder::new().tooltip("序程 · AI 任务看板").menu(&menu).on_menu_event(move|app,event|match event.id.as_ref(){"open"=>show(app),"float"=>{let _=open_floating(app.clone());},"quit"=>request_shutdown(app,&tray_backend),_=>{}});
      if let Some(icon)=app.default_window_icon(){tray=tray.icon(icon.clone());}tray.build(app)?;
      Ok(())
    })
    .on_window_event(|window,event|{if let tauri::WindowEvent::CloseRequested{api,..}=event {api.prevent_close();let _=window.hide();}})
    .build(tauri::generate_context!()).expect("无法启动序程");
  app.run(move |handle,event|{
    if let tauri::RunEvent::ExitRequested{api,..}=event {
      if backend.shutdown.lock().unwrap().exit_code().is_none(){
        api.prevent_exit();
        request_shutdown(handle,&backend);
      }
    }
  });
}
