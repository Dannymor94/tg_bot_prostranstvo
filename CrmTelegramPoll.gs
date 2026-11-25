// Manual TEST polling only; uses the existing sanitized Telegram transport/outbox
// helpers in Code.gs. Do not call legacy installers or reuse the old bot token.
function crmTgPollTest(){
  const lock=LockService.getUserLock();
  if(!lock.tryLock(1000))return {ok:false,reason:"busy"};
  try{
    const env=crmV2BoundTest_(),props=env.props;
    if(props.getProperty("CRM_V2_TELEGRAM_TEST_ENABLED")!=="true")throw Error("Telegram TEST polling disabled");
    const token=props.getProperty("CRM_V2_TEST_TELEGRAM_TOKEN"),owner=props.getProperty("OWNER_CHAT_ID");
    if(!token||!owner||!/^\d+$/.test(owner)||token===props.getProperty("TELEGRAM_TOKEN"))throw Error("Dedicated TEST bot and owner required");
    const cfg={telegramToken:token,ownerChatId:owner};
    tgDeliverOutbox_(cfg,props);
    const offset=Number(props.getProperty("TG_OFFSET")||0);
    if(!Number.isSafeInteger(offset)||offset<0)throw Error("Invalid Telegram offset");
    const updates=telegramApi_(token,"getUpdates",{offset,limit:10,timeout:0,allowed_updates:["message","callback_query"]});
    if(!Array.isArray(updates))throw Error("Invalid Telegram update list");
    let cursor=offset,processed=0;
    for(const u of updates){
      if(!Number.isSafeInteger(u?.update_id)||u.update_id<cursor)throw Error("Unexpected Telegram update order");
      const key="TG_OUTBOX_"+u.update_id,cb=u.callback_query,msg=cb?cb.message:u.message;
      if(cb?.id){try{telegramApi_(token,"answerCallbackQuery",{callback_query_id:cb.id});}catch(e){/* retry on next interaction */}}
      if(!props.getProperty(key)&&msg?.chat?.type==="private"&&Number.isSafeInteger(msg.chat.id)){
        let result;
        try{result=crmTgTestDispatch_(u);}catch(e){result={text:"Сервис временно недоступен. Повтори запрос позже."};}
        if(result)props.setProperty(key,JSON.stringify({chatId:msg.chat.id,reply:result.text,markup:result.reply_markup||null,
          editMessageId:cb?msg.message_id:null,attempts:0,nextAt:0}));
      }
      cursor=u.update_id+1;props.setProperty("TG_OFFSET",String(cursor));processed++;
      if(props.getProperty(key))tgDeliverOutbox_(cfg,props,key);
    }
    return {ok:true,processed};
  }finally{lock.releaseLock();}
}
