import http from "node:http";

const PORT=process.env.PORT||10000;
const SUPABASE_URL=process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY=process.env.SUPABASE_PUBLISHABLE_KEY;
const TINYFISH_API_KEY=process.env.TINYFISH_API_KEY;
const ALLOWED_ORIGIN=process.env.ALLOWED_ORIGIN||"https://student-hire-app.onrender.com";

function send(res,status,data){
  res.writeHead(status,{
    "content-type":"application/json; charset=utf-8",
    "access-control-allow-origin":"*",
    "access-control-allow-headers":"authorization,content-type",
    "access-control-allow-methods":"GET,POST,OPTIONS"
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
  try{
    if(req.method==="GET" && req.url?.startsWith("/api/jobs")){
      const u=new URL(req.url,"https://student-hire-agent.onrender.com");
      const q=(u.searchParams.get("q")||"").trim().slice(0,120);
      const location=(u.searchParams.get("location")||"").trim().slice(0,120);
      if(!q)return send(res,400,{error:"query_required"});
      const searchUrl=new URL("https://www.jobbank.gc.ca/jobsearch/jobsearch");
      searchUrl.searchParams.set("searchstring",q);
      if(location)searchUrl.searchParams.set("locationstring",location);
      searchUrl.searchParams.set("sort","M");

      const headers={"user-agent":"Mozilla/5.0 StudentHireBeta/1.0","accept-language":"en-CA,en;q=0.9"};
      const searchResp=await fetch(searchUrl,{headers});
      if(!searchResp.ok)return send(res,502,{error:"job_source_unavailable"});
      const searchHtml=await searchResp.text();

      const ids=[...searchHtml.matchAll(/jobposting\/(\d+)/gi)]
        .map(m=>m[1]).filter((v,i,a)=>a.indexOf(v)===i).slice(0,12);
      if(!ids.length)return send(res,200,{query:q,location,results:[],sourceUrl:String(searchUrl)});

      const strip=x=>String(x||"")
        .replace(/<script[\s\S]*?<\/script>/gi," ")
        .replace(/<style[\s\S]*?<\/style>/gi," ")
        .replace(/<[^>]+>/g," ")
        .replace(/&amp;/g,"&").replace(/&nbsp;/g," ")
        .replace(/&#39;/g,"'").replace(/&quot;/g,'"')
        .replace(/\s+/g," ").trim();

      const details=await Promise.all(ids.map(async id=>{
        const url="https://www.jobbank.gc.ca/jobsearch/jobposting/"+id+"?source=searchresults";
        try{
          const r=await fetch(url,{headers}); if(!r.ok)return null;
          const h=await r.text();
          const title=strip((h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)||[])[1]||"");
          const employer=strip((h.match(/Employer details[\s\S]{0,900}?<strong[^>]*>([\s\S]*?)<\/strong>/i)||[])[1]||"");
          const locationText=strip((h.match(/<li[^>]*>[\s\S]{0,100}?Location[\s\S]*?<\/li>/i)||[])[0]||"").replace(/^Location\s*/i,"");
          let salary=strip((h.match(/<li[^>]*>[\s\S]{0,100}?Salary[\s\S]*?<\/li>/i)||[])[0]||"").replace(/^Salary\s*/i,"");
          if(!salary){
            const sm=strip(h).match(/Salary\s*(\$[^\n]{0,120}?)(?:Terms of employment|Starts|vacancy|Source)/i);
            salary=sm?sm[1].trim():"";
          }
          const jobNo=(strip(h).match(/Job Bank\s*#([0-9]+)/i)||[])[1]||"";
          const posted=(strip(h).match(/Posted on\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i)||[])[1]||"";
          if(!title)return null;
          return {id,jobNumber:jobNo,title,employer,location:locationText,salary,postedAt:posted,url,source:"Job Bank"};
        }catch{return null}
      }));
      let results=details.filter(Boolean);
      if(location){
        const target=location.split(",")[0].trim().toLowerCase();
        const gta=target==="toronto"?["toronto","north york","scarborough","etobicoke","east york","york","mississauga","vaughan","markham","richmond hill","brampton","pickering"]:[target];
        const local=results.filter(x=>gta.some(city=>String(x.location||"").toLowerCase().includes(city)));
        if(local.length>=3)results=local;
      }
      return send(res,200,{query:q,location,results,sourceUrl:String(searchUrl)});
    }
    if(req.method!=="POST"||req.url!=="/api/apply")return send(res,404,{error:"not_found"});
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
