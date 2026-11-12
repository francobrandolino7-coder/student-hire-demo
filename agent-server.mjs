import http from "node:http";

const PORT=process.env.PORT||10000;
const SUPABASE_URL=process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY=process.env.SUPABASE_PUBLISHABLE_KEY;
const TINYFISH_API_KEY=process.env.TINYFISH_API_KEY;
const ALLOWED_ORIGIN=process.env.ALLOWED_ORIGIN||"https://student-hire-app.onrender.com";

function send(res,status,data){
  res.writeHead(status,{
    "content-type":"application/json; charset=utf-8",
    "access-control-allow-origin":ALLOWED_ORIGIN,
    "access-control-allow-headers":"authorization,content-type",
    "access-control-allow-methods":"POST,OPTIONS"
  });
  res.end(JSON.stringify(data));
}
async function readJson(req){
  let body="";for await(const chunk of req){body+=chunk;if(body.length>250000)throw new Error("payload too large")}
  return body?JSON.parse(body):{};
}
async function authenticatedUser(req){
  const auth=req.headers.authorization||"";
  if(!auth.startsWith("Bearer "))return null;
  const r=await fetch(SUPABASE_URL.replace(/\/$/,"")+"/auth/v1/user",{
    headers:{authorization:auth,apikey:SUPABASE_PUBLISHABLE_KEY}
  });
  if(!r.ok)return null;
  return r.json();
}
const server=http.createServer(async(req,res)=>{
  if(req.method==="OPTIONS")return send(res,204,{});
  if(req.url==="/health")return send(res,200,{ok:true,agentConfigured:Boolean(TINYFISH_API_KEY)});
  if(req.method!=="POST"||req.url!=="/api/apply")return send(res,404,{error:"not_found"});
  try{
    const user=await authenticatedUser(req);
    if(!user)return send(res,401,{error:"unauthorized"});
    const body=await readJson(req);
    if(body.approved!==true)return send(res,400,{error:"explicit_approval_required"});
    if(!body.sourceUrl||!body.packet)return send(res,400,{error:"sourceUrl_and_packet_required"});
    if(!TINYFISH_API_KEY)return send(res,503,{error:"agent_not_configured",message:"Student Hire Agent backend is ready, but the TinyFish API key has not been connected yet."});

    const goal=[
      "You are the Student Hire application agent acting for an authenticated user who explicitly approved this specific application.",
      "Apply only to the job at this URL and use only the approved application packet below.",
      "Do not invent or infer credentials, employment history, education, demographic information, work authorization, salary history, references, dates, or screening answers.",
      "If any required question cannot be answered from the packet, DO NOT submit. Return a result beginning NEEDS_INPUT and include the exact unanswered question(s).",
      "If the application can be completed entirely from the approved packet, review the entered information for accuracy, submit it, and return a result beginning SUBMITTED plus any confirmation number or confirmation text.",
      "Approved application packet:",
      String(body.packet)
    ].join("\n\n");

    const tf=await fetch("https://agent.tinyfish.ai/v1/automation/run",{
      method:"POST",
      headers:{"X-API-Key":TINYFISH_API_KEY,"Content-Type":"application/json"},
      body:JSON.stringify({url:body.sourceUrl,goal})
    });
    const text=await tf.text();
    let result;try{result=JSON.parse(text)}catch{result={raw:text}}
    return send(res,tf.ok?200:502,{ok:tf.ok,result});
  }catch(e){return send(res,500,{error:"server_error",message:e?.message||String(e)})}
});
server.listen(PORT,()=>console.log("Student Hire agent listening on",PORT));
