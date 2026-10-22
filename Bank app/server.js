const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const app = express();
app.use(cors());
app.use(express.json());

if(!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
app.use('/uploads', express.static('uploads'));
app.use(express.static('public'));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if(!ADMIN_PASSWORD) console.log("SET ADMIN_PASSWORD IN ENV!");

const USERS_FILE='./users.json';
const FILES_FILE='./files.json';
const PURCHASES_FILE='./purchases.json';
const FILES_USERS_FILE='./files_users.json';

function loadJson(f,d){ if(!fs.existsSync(f)) return d; try{ return JSON.parse(fs.readFileSync(f,'utf8')) }catch(e){ return d } }
function saveJson(f,d){ fs.writeFileSync(f,JSON.stringify(d,null,2)); }

if(!fs.existsSync(USERS_FILE)) saveJson(USERS_FILE,{});
if(!fs.existsSync(FILES_FILE)) saveJson(FILES_FILE,[]);
if(!fs.existsSync(PURCHASES_FILE)) saveJson(PURCHASES_FILE,[]);
if(!fs.existsSync(FILES_USERS_FILE)) saveJson(FILES_USERS_FILE,{});

function requireAdmin(req,res,next){
  const pass = req.body.adminPassword || req.query.adminPassword || req.headers['x-admin-password'];
  if(pass !== ADMIN_PASSWORD) return res.status(403).json({error:"Admin locked"});
  next();
}

// WHERE FILE SAVES - Real upload
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req,file,cb)=>{ cb(null, Date.now()+'-'+file.originalname.replace(/\s/g,'_')); }
});
const upload = multer({storage});

app.post('/api/admin/upload-file', requireAdmin, upload.single('projectFile'), (req,res)=>{
  const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({success:true, fileUrl, filename:req.file.filename});
});

app.get('/',(req,res)=>res.sendFile(__dirname+'/public/admin.html'));

// ✅ BANK APP LOADS PROJECTS FROM HERE - Connected to admin
app.get('/api/bank/projects',(req,res)=>{
  res.json({files: loadJson(FILES_FILE,[])});
});

function checkDailyBonus(u){
  if(u.dailyBonusGiven) return false;
  if(Date.now() - new Date(u.createdAt).getTime() >= 86400000){
    u.balance+=1000; u.dailyBonusGiven=true;
    u.notifications.unshift({id:Date.now(),title:`You received ₦1000 Daily Bonus from INRI System`,body:`Bonus`,amount:1000,from:"INRI System",date:new Date().toLocaleString(),read:false});
    return true;
  }
  return false;
}

// BANK APP APIS
app.post('/api/bank/register',(req,res)=>{
  const {name,phone,password}=req.body;
  if(!phone||phone.length!=11) return res.status(400).json({error:"11 digits"});
  const users=loadJson(USERS_FILE,{});
  if(users[phone]) return res.status(400).json({error:"exists"});
  users[phone]={name,phone,password,accountNumber:"INRI-"+phone.slice(-4)+"-"+Math.floor(1000+Math.random()*9000),balance:0,banned:false,createdAt:new Date().toISOString(),dailyBonusGiven:false,notifications:[{id:Date.now(),title:"Welcome to INRI HACK",body:"Account with ₦0",from:"System",date:new Date().toLocaleString(),read:false}]};
  saveJson(USERS_FILE,users); res.json({success:true});
});

app.post('/api/bank/login',(req,res)=>{
  const users=loadJson(USERS_FILE,{});
  const u=users[req.body.phone];
  if(!u) return res.status(404).json({error:"not_found"});
  if(u.password!==req.body.password) return res.status(401).json({error:"wrong"});
  if(u.banned) return res.status(403).json({error:"banned"});
  if(checkDailyBonus(u)) saveJson(USERS_FILE,users);
  res.json({success:true,user:u});
});

app.get('/api/bank/user/:phone',(req,res)=>{
  const users=loadJson(USERS_FILE,{});
  const u=users[req.params.phone];
  if(!u) return res.status(404).json({error:"not_found"});
  if(checkDailyBonus(u)) saveJson(USERS_FILE,users);
  res.json(u);
});

app.post('/api/bank/check-account',(req,res)=>{
  const users=loadJson(USERS_FILE,{});
  const f=Object.values(users).find(x=>x.accountNumber===req.body.accountNumber||x.phone===req.body.accountNumber);
  res.json(f?{exists:true,name:f.name,accountNumber:f.accountNumber}:{exists:false});
});

app.post('/api/bank/transfer',(req,res)=>{
  const users=loadJson(USERS_FILE,{});
  const s=users[req.body.fromPhone];
  if(!s||s.balance<parseFloat(req.body.amount)) return res.status(400).json({error:"insufficient"});
  const r=Object.values(users).find(x=>x.accountNumber===req.body.toAccount||x.phone===req.body.toAccount);
  if(!r) return res.status(404).json({error:"receiver not found"});
  s.balance-=parseFloat(req.body.amount); users[r.phone].balance+=parseFloat(req.body.amount);
  users[r.phone].notifications.unshift({id:Date.now(),title:`You received ₦${req.body.amount} from ${s.name}`,body:`${s.name} sent you ₦${req.body.amount}`,amount:parseFloat(req.body.amount),from:s.name,fromPhone:s.phone,date:new Date().toLocaleString(),read:false});
  saveJson(USERS_FILE,users); res.json({success:true,newBalance:s.balance});
});

// ✅ BUY PROJECT - Gives login for Files App
app.post('/api/bank/buy',(req,res)=>{
  const {phone,fileId}=req.body;
  const users=loadJson(USERS_FILE,{});
  const files=loadJson(FILES_FILE,[]);
  const purchases=loadJson(PURCHASES_FILE,[]);
  const filesUsers=loadJson(FILES_USERS_FILE,{});
  const user=users[phone];
  const file=files.find(f=>f.id==fileId);
  if(!user||!file) return res.status(404).json({error:"not_found"});
  if(user.balance < file.price) return res.status(400).json({error:"insufficient_balance"});

  // If already bought, return same login
  let already = purchases.find(p=>p.phone==phone && p.fileId==fileId);
  if(already) return res.json({success:true,fileUsername:already.username,filePassword:already.password,fileTitle:already.fileTitle,downloadLink:already.downloadLink});

  user.balance-=file.price;

  // Generate Files App login - This is what user will use in Files App
  const fileUsername = "INRI_"+phone.slice(-4)+"_"+fileId;
  const filePassword = "FILE-"+Math.random().toString(36).substring(2,8).toUpperCase();

  filesUsers[fileUsername]={
    username:fileUsername, password:filePassword, phone:phone,
    fileId:fileId, fileTitle:file.title, downloadLink:file.downloadLink, desc:file.desc,
    createdAt:new Date().toISOString()
  };

  purchases.push({phone,fileId,fileTitle:file.title,username:fileUsername,password:filePassword,downloadLink:file.downloadLink,date:new Date().toISOString()});

  users[phone].notifications.unshift({
    id:Date.now(),
    title:`You bought ${file.title}`,
    body:`FILES APP LOGIN - Username: ${fileUsername} Password: ${filePassword} - Use it in Files App`,
    amount:file.price, from:"INRI Store", date:new Date().toLocaleString(), read:false
  });

  saveJson(USERS_FILE,users);
  saveJson(FILES_USERS_FILE,filesUsers);
  saveJson(PURCHASES_FILE,purchases);

  res.json({success:true,fileUsername,filePassword,fileTitle:file.title,downloadLink:file.downloadLink});
});

// FILES APP APIS - Login with generated credentials
app.post('/api/files/login',(req,res)=>{
  const filesUsers=loadJson(FILES_USERS_FILE,{});
  const u=filesUsers[req.body.username];
  if(!u||u.password!==req.body.password) return res.status(401).json({error:"invalid_login"});
  res.json({success:true,fileTitle:u.fileTitle,downloadLink:u.downloadLink,username:u.username,desc:u.desc});
});

app.get('/api/files/myfiles/:phone',(req,res)=>{
  const filesUsers=loadJson(FILES_USERS_FILE,{});
  const my=Object.values(filesUsers).filter(f=>f.phone===req.params.phone);
  res.json({files:my});
});

// ADMIN APIS - With verification ?adminPassword=ENV
app.get('/api/admin/files', requireAdmin, (req,res)=>{ res.json({files:loadJson(FILES_FILE,[])}); });
app.get('/api/admin/bank/users', requireAdmin, (req,res)=>{ res.json(loadJson(USERS_FILE,{})); });
app.post('/api/admin/check',(req,res)=>{ res.json({success:(req.body.adminPassword||req.query.adminPassword)===ADMIN_PASSWORD}); });
app.post('/api/admin/bank/addmoney', requireAdmin, (req,res)=>{ const users=loadJson(USERS_FILE,{}); users[req.body.phone].balance+=parseFloat(req.body.amount); users[req.body.phone].notifications.unshift({id:Date.now(),title:`You received ₦${req.body.amount} from Admin`,amount:parseFloat(req.body.amount),from:"Admin",date:new Date().toLocaleString(),read:false}); saveJson(USERS_FILE,users); res.json({success:true,newBalance:users[req.body.phone].balance}); });
app.post('/api/admin/bank/edit', requireAdmin, (req,res)=>{ const users=loadJson(USERS_FILE,{}); if(users[req.body.phone]){ if(req.body.balance) users[req.body.phone].balance=parseFloat(req.body.balance); if(req.body.name) users[req.body.phone].name=req.body.name; saveJson(USERS_FILE,users);} res.json({success:true}); });
app.post('/api/admin/bank/ban', requireAdmin, (req,res)=>{ const users=loadJson(USERS_FILE,{}); if(users[req.body.phone]){ users[req.body.phone].banned=!users[req.body.phone].banned; saveJson(USERS_FILE,users);} res.json({success:true}); });
app.post('/api/admin/files', requireAdmin, (req,res)=>{ const files=loadJson(FILES_FILE,[]); const nf={id:Date.now(),title:req.body.title,desc:req.body.desc,price:parseFloat(req.body.price),downloadLink:req.body.downloadLink,date:new Date().toLocaleString()}; files.unshift(nf); saveJson(FILES_FILE,files); res.json({success:true,file:nf}); });
app.post('/api/admin/files/delete', requireAdmin, (req,res)=>{ let files=loadJson(FILES_FILE,[]); files=files.filter(f=>f.id!=req.body.id); saveJson(FILES_FILE,files); res.json({success:true}); });

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log("RUNNING "+PORT));'/api/admin/bank/users', requireAdmin, (req,res)=>{res.json(loadJson(USERS_FILE,{}))});
app.get('/api/admin/files', requireAdmin, (req,res)=>{res.json({files:loadJson(FILES_FILE,[])})});

// Admin login check
app.post('/api/admin/check',(req,res)=>{
  if(req.body.adminPassword !== ADMIN_PASSWORD) return res.status(403).json({success:false});
  res.json({success:true});
});

app.post('/api/admin/bank/addmoney', requireAdmin, (req,res)=>{
  const {phone,amount}=req.body;
  const users=loadJson(USERS_FILE,{});
  if(!users[phone])return res.status(404).json({error:"user_not_found"});
  let amt = parseFloat(amount);
  users[phone].balance+=amt;
  users[phone].notifications.unshift({
    id: Date.now(),
    title: `You received ₦${amt} from Admin`,
    body: `Admin credited ₦${amt}. New balance ₦${users[phone].balance}`,
    amount: amt, from: "Admin", date: new Date().toLocaleString(), read: false
  });
  saveJson(USERS_FILE,users);
  res.json({success:true,newBalance:users[phone].balance});
});

app.post('/api/admin/bank/ban', requireAdmin, (req,res)=>{
  const {phone}=req.body;
  const users=loadJson(USERS_FILE,{});
  if(users[phone]){users[phone].banned=!users[phone].banned; saveJson(USERS_FILE,users)}
  res.json({success:true});
});

app.post('/api/admin/bank/edit', requireAdmin, (req,res)=>{
  const {phone,balance,name}=req.body;
  const users=loadJson(USERS_FILE,{});
  if(users[phone]){if(balance!==undefined)users[phone].balance=parseFloat(balance); if(name)users[phone].name=name; saveJson(USERS_FILE,users)}
  res.json({success:true});
});

app.post('/api/admin/files', requireAdmin, (req,res)=>{
  const {title,desc,price,downloadLink}=req.body;
  let p = parseFloat(price);
  if(p < 500) return res.status(400).json({error:"Minimum price is ₦500"});
  const files=loadJson(FILES_FILE,[]);
  const newFile={id:Date.now(),title,desc,price:p,downloadLink,date:new Date().toLocaleString()};
  files.unshift(newFile);
  saveJson(FILES_FILE,files);
  res.json({success:true,file:newFile});
});

app.post('/api/admin/files/delete', requireAdmin, (req,res)=>{
  const {id}=req.body;
  let files=loadJson(FILES_FILE,[]); files=files.filter(f=>f.id!=id); saveJson(FILES_FILE,files); res.json({success:true});
});

app.get('/reset-all-zero', requireAdmin, (req,res)=>{
  const users=loadJson(USERS_FILE,{});
  for(let p in users){ users[p].balance = 0; users[p].dailyBonusGiven = false; }
  saveJson(USERS_FILE,users);
  res.send("All reset to ₦0");
});

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`INRI FINAL ENV-LOCKED running ${PORT}`));
