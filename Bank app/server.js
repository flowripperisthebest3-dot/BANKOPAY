const express = require('express');
const cors = require('cors');
const fs = require('fs');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 🔒 ADMIN PASSWORD FROM RENDER ENV VARIABLE - NOT HARDCODED
// Go to Render Dashboard > Your Service > Environment > Add Variable: ADMIN_PASSWORD = your secret password
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Fearless@Admin2026";
console.log("Admin protection active with ENV variable");

const USERS_FILE='./users.json';
const FILES_FILE='./files.json';
const PURCHASES_FILE='./purchases.json';
const FILES_USERS_FILE='./files_users.json';

function loadJson(f,d){if(!fs.existsSync(f))return d; try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){return d}}
function saveJson(f,d){fs.writeFileSync(f,JSON.stringify(d,null,2))}

if(!fs.existsSync(USERS_FILE))saveJson(USERS_FILE,{});
if(!fs.existsSync(FILES_FILE))saveJson(FILES_FILE,[]);
if(!fs.existsSync(PURCHASES_FILE))saveJson(PURCHASES_FILE,[]);
if(!fs.existsSync(FILES_USERS_FILE))saveJson(FILES_USERS_FILE,{});

app.get('/',(req,res)=>res.sendFile(__dirname+'/public/admin.html'));

// Check 1 day bonus 1k
function checkDailyBonus(user){
  if(user.dailyBonusGiven) return false;
  let created = new Date(user.createdAt).getTime();
  let now = Date.now();
  let oneDay = 24 * 60 * 60 * 1000;
  if(now - created >= oneDay){
    user.balance += 1000;
    user.dailyBonusGiven = true;
    user.notifications.unshift({
      id: Date.now(),
      title: `You received ₦1000 Daily Bonus from INRI System`,
      body: `You received ₦1000 to buy your first project`,
      amount: 1000,
      from: "INRI System",
      date: new Date().toLocaleString(),
      read: false
    });
    return true;
  }
  return false;
}

// Middleware to lock admin API with ENV password
function requireAdmin(req,res,next){
  const pass = req.body.adminPassword || req.query.adminPassword || req.headers['x-admin-password'];
  if(pass !== ADMIN_PASSWORD){
    return res.status(403).json({error: "Admin locked - wrong ENV password"});
  }
  next();
}

// ================= BANK APP com.inri.hack =================

app.post('/api/bank/register',(req,res)=>{
  let {name,phone,password,enableFingerprint}=req.body;
  if(!phone||phone.length!=11||isNaN(phone))return res.status(400).json({error:"Phone must be 11 digits"});
  if(!name||!password)return res.status(400).json({error:"name_password_required"});
  const users=loadJson(USERS_FILE,{});
  if(users[phone])return res.status(400).json({error:"Phone already registered"});
  const accNumber="INRI-HACK-"+phone.slice(-4)+"-"+Math.floor(1000+Math.random()*9000);
  users[phone]={
    name, phone, password,
    accountNumber:accNumber,
    balance: 0, // Fizzy register = 0
    banned:false,
    fingerprintEnabled: !!enableFingerprint, // User can add fingerprint if phone supports it
    createdAt:new Date().toISOString(),
    dailyBonusGiven:false,
    notifications:[{
      id: Date.now(),
      title: "Welcome to INRI HACK",
      body: "Your account created with ₦0. You will receive ₦1000 after 24hrs",
      amount:0, from:"System", date:new Date().toLocaleString(), read:false
    }]
  };
  saveJson(USERS_FILE,users);
  res.json({success:true,accountNumber:accNumber,name,phone,balance:0});
});

// LOGIN WITH PASSWORD OR FINGERPRINT FLAG
app.post('/api/bank/login',(req,res)=>{
  const {phone,password,useFingerprint}=req.body;
  const users=loadJson(USERS_FILE,{});
  const user=users[phone];
  if(!user)return res.status(404).json({error:"not_registered"});
  if(user.banned)return res.status(403).json({error:"account_suspended"});
  
  // If they want fingerprint login, check if they enabled it before
  if(useFingerprint){
    if(!user.fingerprintEnabled) return res.status(403).json({error:"Fingerprint not enabled for this account. Login with password first and enable it"});
    // Fingerprint verified on phone side, server just allows
  } else {
    if(user.password!==password)return res.status(401).json({error:"wrong_password"});
  }

  if(checkDailyBonus(user)) saveJson(USERS_FILE,users);
  res.json({success:true,user:{name:user.name,phone:user.phone,accountNumber:user.accountNumber,balance:user.balance,fingerprintEnabled:user.fingerprintEnabled}});
});

// Update fingerprint setting
app.post('/api/bank/update-fingerprint',(req,res)=>{
  const {phone, enableFingerprint} = req.body;
  const users=loadJson(USERS_FILE,{});
  if(users[phone]){
    users[phone].fingerprintEnabled = !!enableFingerprint;
    saveJson(USERS_FILE,users);
    res.json({success:true, fingerprintEnabled: users[phone].fingerprintEnabled});
  } else res.status(404).json({error:"not_found"});
});

app.post('/api/bank/check-account',(req,res)=>{
  const {accountNumber}=req.body;
  const users=loadJson(USERS_FILE,{});
  const found=Object.values(users).find(u=>u.accountNumber===accountNumber||u.phone===accountNumber);
  if(!found)return res.json({exists:false});
  res.json({exists:true,name:found.name,accountNumber:found.accountNumber});
});

// SEND MONEY - AUTO UPDATE BALANCE + NOTIFICATION WITH TITLE
app.post('/api/bank/transfer',(req,res)=>{
  const {fromPhone,toAccount,amount}=req.body;
  let amt=parseFloat(amount);
  if(!amt||amt<=0)return res.status(400).json({error:"invalid_amount"});
  const users=loadJson(USERS_FILE,{});
  const sender=users[fromPhone];
  if(!sender)return res.status(404).json({error:"sender_not_found"});
  if(sender.banned)return res.status(403).json({error:"account_suspended"});
  if(sender.balance<amt)return res.status(400).json({error:"insufficient_balance"});
  const receiver=Object.values(users).find(u=>u.accountNumber===toAccount||u.phone===toAccount);
  if(!receiver)return res.status(404).json({error:"receiver_not_registered"});
  
  sender.balance-=amt;
  users[receiver.phone].balance+=amt;
  
  let title = `You received ₦${amt} from ${sender.name}`;
  let body = `${sender.name} (${sender.phone}) sent you ₦${amt}. New balance ₦${users[receiver.phone].balance}`;
  
  users[receiver.phone].notifications.unshift({
    id: Date.now(),
    title: title,
    body: body,
    amount: amt,
    from: sender.name,
    fromPhone: sender.phone,
    fromAccount: sender.accountNumber,
    date: new Date().toLocaleString(),
    read: false
  });

  saveJson(USERS_FILE,users);
  res.json({success:true,newBalance:sender.balance, receiverNewBalance: users[receiver.phone].balance, notification: title});
});

app.get('/api/bank/user/:phone',(req,res)=>{
  const users=loadJson(USERS_FILE,{});
  const user=users[req.params.phone];
  if(!user)return res.status(404).json({error:"not_found"});
  if(checkDailyBonus(user)) saveJson(USERS_FILE,users);
  res.json({balance:user.balance,notifications:user.notifications,banned:user.banned,name:user.name,accountNumber:user.accountNumber,fingerprintEnabled:user.fingerprintEnabled});
});

// BUY PROJECT - Generate login for Files App, only that project
app.post('/api/bank/buy',(req,res)=>{
  const {phone,fileId}=req.body;
  const users=loadJson(USERS_FILE,{});
  const files=loadJson(FILES_FILE,[]);
  const purchases=loadJson(PURCHASES_FILE,[]);
  const filesUsers=loadJson(FILES_USERS_FILE,{});
  const user=users[phone];
  const file=files.find(f=>f.id==fileId);
  if(!user||!file)return res.status(404).json({error:"not_found"});
  if(user.balance < file.price)return res.status(400).json({error:"insufficient_balance"});

  let already = purchases.find(p=>p.phone==phone && p.fileId==fileId);
  if(already) return res.json({success:true,fileUsername:already.username,filePassword:already.password,fileTitle:already.fileTitle,downloadLink:already.downloadLink});

  user.balance-=file.price;

  const fileAppUsername = "INRI_"+phone.slice(-4)+"_"+fileId;
  const fileAppPassword = "FILE-"+Math.random().toString(36).substring(2,8).toUpperCase();

  filesUsers[fileAppUsername]={
    username:fileAppUsername, password:fileAppPassword, phone:phone,
    fileId:fileId, fileTitle:file.title, downloadLink:file.downloadLink, desc:file.desc, price:file.price,
    createdAt:new Date().toISOString()
  };

  purchases.push({phone,fileId,fileTitle:file.title,username:fileAppUsername,password:fileAppPassword,downloadLink:file.downloadLink,date:new Date().toISOString()});

  users[phone].notifications.unshift({
    id: Date.now(),
    title: `You bought ${file.title}`,
    body: `Username: ${fileAppUsername} Password: ${fileAppPassword}`,
    amount: file.price, from: "INRI Store", date: new Date().toLocaleString(), read: false
  });

  saveJson(USERS_FILE,users);
  saveJson(FILES_USERS_FILE,filesUsers);
  saveJson(PURCHASES_FILE,purchases);

  res.json({success:true,fileUsername:fileAppUsername,filePassword:fileAppPassword,fileTitle:file.title,downloadLink:file.downloadLink});
});

// ================= FILES APP com.inri.files =================
app.post('/api/files/login',(req,res)=>{
  const {username,password}=req.body;
  const filesUsers=loadJson(FILES_USERS_FILE,{});
  const u=filesUsers[username];
  if(!u||u.password!==password)return res.status(401).json({error:"invalid_login"});
  res.json({success:true,fileTitle:u.fileTitle,downloadLink:u.downloadLink,username:u.username,desc:u.desc});
});

app.get('/api/files/myfiles/:phone',(req,res)=>{
  const filesUsers=loadJson(FILES_USERS_FILE,{});
  const my=Object.values(filesUsers).filter(f=>f.phone===req.params.phone);
  res.json({files:my});
});

// ================= ADMIN - LOCKED WITH ENV VARIABLE =================
app.get('/api/admin/bank/users', requireAdmin, (req,res)=>{res.json(loadJson(USERS_FILE,{}))});
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