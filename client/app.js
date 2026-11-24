// DJAchat — cliente (roda no app desktop Electron ou no navegador em localhost)
'use strict';

// O resto do cliente está em nucleo.js, chat.js, voz.js, configuracoes.js, menus.js, perfil.js e busca.js.

// ================================================================ início
// Não há "sair da voz" ao sair da página: esse evento também dispara em navegações que o app bloqueia
// (como clicar num arquivo), e tirava a pessoa da sala. Ao fechar o app, a conexão cai e o servidor já a tira.
refreshButtons();   // estado inicial dos botões de microfone e fone
showLogin();
if (LS.get('name') && LS.get('server') && LS.get('session')) $('#loginForm').requestSubmit();
