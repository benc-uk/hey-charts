// Load .env file if it exists
require('dotenv').config()
const fs = require('fs')
const child_process = require('child_process');
const fileUpload = require('express-fileupload');

const DATA_DIR = `${__dirname}/data/`
const SITE_DIR = `${__dirname}/site/`
const BIN_DIR  = `${__dirname}/bin/`

// Load in modules, and create Express app 
var express = require('express');
var app = express();
app.use(fileUpload({ useTempFiles: true }));
app.use(express.json());

// Serve the site
const dataDir = require('path').resolve(DATA_DIR)
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}
const siteDir = require('path').resolve(SITE_DIR)
const binDir = require('path').resolve(BIN_DIR)
app.use('/', express.static(siteDir));
app.use('/data', express.static(dataDir));

//
// Mini API for listing CSV files
//
app.get('/api/files', function (req, res) {
  let data = { files: [] };
  data.files = walkDir(dataDir)
  res.send(data);
});

const walkDir = function(dir) {
  var results = [];
  var list = fs.readdirSync(dir);
  list.forEach(function(file) {
      file = dir + '/' + file;
      var stat = fs.statSync(file);
      if (stat && stat.isDirectory()) { 
          // Recurse into a subdirectory 
          results = results.concat(walkDir(file));
      } else { 
          // Only add CSV files and strip the top level dir prefix from name
          if(file.toLowerCase().endsWith('.csv')) {
            let name = file.replace(`${dataDir}/`, '');
            results.push(name);
          }
      }
  });
  return results;
}

var heyProcess = null;
var heyExitCode = -1;
var badData = false
//
// API for running hey
//
app.post('/api/run', function (req, res) {
  if(heyProcess) { res.status(400).send({msg:'Load generator already running'}); return; }
  
  let output = "";
  let paramString = req.body.params;
  let url = req.body.url;

  var urlParsed;
  try {
    const { URL } = require('url');
    urlParsed = new URL(url);
  } catch (error) {
    res.status(400).send({msg:'URL is invalid'});
    return;
  }

  let date = new Date().toISOString();
  date = date.replace('T', ' ').replace(/\:/g, '.').substring(0, date.length-5)

  let paramArray = []
  if(paramString.length > 0) paramArray.push(...paramString.split(" "))
  paramArray.push(...['-o', 'csv'])
  paramArray.push(url)
  heyExitCode = -1
  badData = false
  
  heyProcess = child_process.spawn('bin/hey', paramArray);
  console.log(`### Running: bin/hey ${paramString} -o csv ${url}`)

  var dataBlock = 0
  heyProcess.stdout.on('data', (data) => {
    
    let dataString = data.toString();
    if(dataBlock == 0) {
      // Check output for keywords that indicate we didn't get CSV response
      // The hey command isn't great at error checking, can't rely on exit code 
      if(dataString.includes('Summary:') || dataString.includes('Options:') || dataString.length < 100) {
        badData = true;
        return;
      }
    }

    output += dataString
    dataBlock++
  });
  
  heyProcess.stderr.on('data', (data) => {
    console.error(`### Hey error! ${data}`);
    heyProcess = null
  });

  heyProcess.on('error', (code) => {
    console.log(`### Hey exited with error: ${code}`);
    heyExitCode = code
    heyProcess = null
  });

  heyProcess.on('exit', (code) => {
    console.log(`### Hey completed: ${code} badData: ${badData}`);
    heyProcess = null
    if(badData) {
      heyExitCode = 70;
      return;
    }
    heyExitCode = code
    if(code === 0 && output.length > 0) fs.writeFileSync(`${dataDir}/${urlParsed.hostname} ${date}.csv`, output)
  });

  res.send({msg:'Started'});
});

//
// API for getting process status
//
app.get('/api/run', function (req, res) {
  if(!heyProcess) { res.send({running: false, code: heyExitCode}); return; }
  if(heyProcess) { res.send({running: true, code: heyExitCode}); return; }
})

//
// API for file upload
//
app.post('/api/upload', function(req, res) {
  if(!req.files.upload) {
    res.send('File upload error<br/><a href="/">BACK</a>')
    return;
  }

  let uploadedFile = req.files.upload;
  console.log(`### Uploaded: ${uploadedFile.name} MIME: ${uploadedFile.mimetype}`);

  if(['application/x-zip-compressed', 'application/zip'].indexOf(uploadedFile.mimetype) >= 0) {
    const unzipper = require('unzipper');
    fs.createReadStream(uploadedFile.tempFilePath).pipe(unzipper.Extract({ path: './data' }));
  } else if(['application/vnd.ms-excel', 'text/csv'].indexOf(uploadedFile.mimetype) >= 0) {
    uploadedFile.mv(dataDir + "/" + uploadedFile.name);
  } else {
    res.send('Uploaded file invalid type (CSV and ZIP only)<br/><a href="/">BACK</a>')
    return;    
  }
  
  res.redirect('/');
});

// Start the Express server
var port = process.env.PORT || 3000;
console.log(`### App version ${require('./package.json').version} is starting...`);
var server = require('http').createServer(app);
server.keepAliveTimeout = 0; // This is a workaround for WSL v2 issues
server.listen(port);
console.log(`### API server listening on ${server.address().port}`);  

// var server = app.listen(port, function () {  
//   console.log(`### Server is listening on port ${server.address().port}`);
// });