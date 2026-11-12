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
      const user=await authenticatedUser(req);
      if(!user)return send(res,401,{error:"unauthorized"});
      const u=new URL(req.url,"https://student-hire-agent.onrender.com");
      const q=(u.searchParams.get("q")||"").trim().slice(0,120);
      const location=(u.searchParams.get("location")||"").trim().slice(0,120);
      if(!q)return send(res,400,{error:"query_required"});
      const searchUrl=new URL("https://www.jobbank.gc.ca/jobsearch/jobsearch");
      searchUrl.searchParams.set("searchstring",q);
      if(location)searchUrl.searchParams.set("locationstring",location);
      searchUrl.searchParams.set("sort","M");

      const searchResp=await fetch(searchUrl,{headers:{"user-agent":"Mozilla/5.0 StudentHireBeta/1.0"}});
      if(!searchResp.ok)return send(res,502,{error:"job_source_unavailable"});
      const searchHtml=await searchResp.text();
      const decoded=searchHtml.replace(/&amp;/g,"&");
      const rssMatch=decoded.match(/https:\/\/www\.jobbank\.gc\.ca\/jobsearch\/feed\/jobSearchRSSfeed[^"'<>\s]*/i) ||
        decoded.match(/\/jobsearch\/feed\/jobSearchRSSfeed[^"'<>\s]*/i);
      let feedUrl;
      if(rssMatch){
        feedUrl=rssMatch[0].startsWith("http")?rssMatch[0]:"https://www.jobbank.gc.ca"+rssMatch[0];
      }else{
        feedUrl="https://www.jobbank.gc.ca/jobsearch/feed/jobSearchRSSfeed?term="+encodeURIComponent(q)+"&sort=D&rows=50";
      }
      const feedResp=await fetch(feedUrl,{headers:{"user-agent":"Mozilla/5.0 StudentHireBeta/1.0"}});
      if(!feedResp.ok)return send(res,502,{error:"job_feed_unavailable"});
      const xml=await feedResp.text();
      const entries=[...xml.matchAll(/<entry[\s\S]*?<\/entry>/gi)].map(m=>m[0]);
      const items=[];
      const strip=x=>String(x||"").replace(/<!\[CDATA\[|\]\]>/g,"").replace(/<[^>]+>/g," ").replace(/&amp;/g,"&").replace(/&nbsp;/g," ").replace(/\s+/g," ").trim();
      const pick=(block,re)=>{const m=block.match(re);return m?strip(m[1]):""};
      for(const block of entries.slice(0,40)){
        const title=pick(block,/<title[^>]*>([\s\S]*?)<\/title>/i);
        const updated=pick(block,/<updated[^>]*>([\s\S]*?)<\/updated>/i);
        const summaryRaw=(block.match(/<(?:summary|content)[^>]*>([\s\S]*?)<\/(?:summary|content)>/i)||[])[1]||"";
        const summary=strip(summaryRaw);
        const href=(block.match(/<link[^>]+href=["']([^"']+)["']/i)||[])[1]||"";
        const jobNo=(summary.match(/Job number:\s*([^\s<]+)/i)||[])[1]||"";
        const employer=(summary.match(/Employer:\s*(.*?)(?:Salary:|$)/i)||[])[1]?.trim()||"";
        const salary=(summary.match(/Salary:\s*(.*)$/i)||[])[1]?.trim()||"";
        const loc=(summary.match(/Location:\s*(.*?)(?:Employer:|$)/i)||[])[1]?.trim()||"";
        const finalUrl=jobNo?("https://www.jobbank.gc.ca/jobsearch/jobposting/"+encodeURIComponent(jobNo)+"?source=searchresults"):href;
        if(title&&finalUrl)items.push({id:jobNo||finalUrl,title,employer,location:loc,salary,postedAt:updated,url:finalUrl,source:"Job Bank"});
      }
      if(!items.length){
        const ids=[...decoded.matchAll(/jobposting\/(\d+)/g)].map(m=>m[1]).filter((v,i,a)=>a.indexOf(v)===i).slice(0,20);
        for(const id of ids)items.push({id,title:"Job Bank listing",employer:"",location:location||"",salary:"",postedAt:"",url:"https://www.jobbank.gc.ca/jobsearch/jobposting/"+id+"?source=searchresults",source:"Job Bank"});
      }
      return send(res,200,{query:q,location,results:items.slice(0,20),sourceUrl:String(searchUrl)});
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
