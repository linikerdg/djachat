# DJAchat — chat e chamadas para a galera

Canais de texto, canais de voz, soundboard, compartilhamento de tela e envio de arquivos.
Feito para uso privado entre amigos, no desktop.

```
djachat/
├── server/    → o servidor (só UMA pessoa roda)
├── client/    → a interface (HTML/CSS/JS)
└── desktop/   → o app desktop (Electron) que todo mundo abre
```

## Como funciona

- **Um de vocês é o "host"** e deixa o servidor rodando no PC dele. O servidor guarda as mensagens, os arquivos e os sons. Ele também avisa quem está em cada sala.
- **Voz e tela vão direto de PC para PC** (WebRTC), sem passar pelo servidor. Por isso a latência é baixa, mas cada pessoa envia o próprio áudio e vídeo para cada uma das outras. Funciona bem com **até umas 6 a 8 pessoas na mesma sala**. A tela compartilhada pesa mais no upload de quem transmite.
- Sem OneDrive, os dados ficam em `server/data/` (`db.json` + pasta `files/`). Para fazer backup, é só copiar essa pasta.
- Com OneDrive, as conversas, os canais, os sons, os arquivos e a senha ficam no OneDrive. Qualquer amigo pode abrir o servidor no PC dele e todos veem os mesmos dados (veja a seção OneDrive).

---

## 1. Instalar o Node.js (todo mundo)

Baixe o **Node.js LTS** em https://nodejs.org e instale normalmente.

## 2. Colocar todos na mesma rede (recomendado: VPN de jogos)

Para os PCs se enxergarem pela internet, o jeito mais fácil é uma VPN virtual gratuita. Todos instalam a mesma:

- **Radmin VPN** (Windows, muito simples): o host cria uma rede com nome e senha, e os amigos entram nela.
- **Tailscale** ou **ZeroTier** (Windows/Mac/Linux): mesma ideia.

Assim cada PC ganha um IP virtual (ex.: `26.x.x.x` no Radmin, `100.x.x.x` no Tailscale), e a voz e a tela funcionam mesmo atrás de CGNAT, que é comum nas operadoras brasileiras.

> Alternativa sem VPN: o host libera a porta **3000 (TCP)** no roteador e os amigos usam o IP público dele. A voz pode falhar em algumas conexões, por isso a VPN é a opção mais garantida.

## 3. Rodar o servidor (só o host)

No Windows, dê dois cliques em **`iniciar-servidor.bat`**. Ou pelo terminal:

```bash
cd server
node server.js
```

Na primeira vez, o servidor gera uma senha, guarda em `server/data/config.json` e mostra no terminal. Para escolher a sua:

```bash
SENHA=minhasenha node server.js          # Mac/Linux
set "SENHA=minhasenha" && node server.js # Windows (cmd)
```

Para rodar sem senha, só em rede de confiança, use `SEM_SENHA=1`. Os uploads têm limite total de 20 GB; para mudar, use `LIMITE_DISCO_GB`.

O terminal mostra os endereços. Passe para os amigos o IP da VPN com a porta, por exemplo `26.123.45.67:3000`.
O servidor não precisa de `npm install`, porque não tem dependências.

## 4. Abrir o app (todo mundo, inclusive o host)

Na primeira vez, dê dois cliques em **`abrir-app.bat`**, ou:

```bash
cd desktop
npm install      # só na primeira vez (baixa o Electron, ~100 MB)
npm start
```

Na tela de entrada, preencha o **endereço do servidor**, o **apelido** e a **senha**. O app lembra esses dados e entra sozinho nas próximas vezes.
O host usa `localhost:3000`.

### Gerar um instalador para mandar para os amigos (opcional)

```bash
cd desktop
npm run build
```

O arquivo `desktop/dist/DJAchat-Instalador.exe` instala o app sem pedir administrador e sem precisar do Node.

---

## Como usar

| Recurso | Onde |
|---|---|
| Criar/apagar canal | `＋` ao lado de "Canais de texto/voz"; `✕` ao passar o mouse no canal |
| Enviar arquivo | botão `＋` na caixa de mensagem, **arrastar e soltar**, ou **Ctrl+V** de imagem (até 500 MB) |
| Entrar na voz | clique no canal de voz; clique de novo para ver a sala |
| Mutar / ensurdecer | 🎙️ / 🎧 no canto inferior esquerdo |
| Volume de cada amigo | passe o mouse no card da pessoa dentro da sala |
| Compartilhar tela | botão **🖥️ Tela** (escolha a tela ou janela; no Windows dá para mandar o som do PC junto) |
| Assistir à tela de alguém | aparece na sala; `⤢` foca, `⛶` ou duplo clique deixa em tela cheia |
| Soundboard | botão **🎵 Sons**: adicione mp3/ogg/wav (até 3 MB) com um emoji, e quem está na sala ouve |
| Microfone, saída de áudio, ruído, qualidade da tela | ⚙️ Configurações |
| Opções de uma pessoa (volume até 200%, mutar só para você, mensagem direta, mencionar, mover ou tirar da sala) | clique direito na pessoa |
| Responder, reagir, editar ou apagar a sua mensagem | clique direito na mensagem |
| Baixar, abrir ou copiar um anexo | clique direito no anexo |
| Renomear, silenciar ou marcar canal como lido | clique direito no canal |
| Renomear, trocar emoji ou ouvir um som só para você | clique direito no som |
| Volume do som da tela, janela flutuante | clique direito na tela que está assistindo |
| Fechar a janela | o X deixa o app na bandeja do sistema (dá para mudar em ⚙️ → Janela e app); para sair, clique direito no ícone da bandeja → Sair |
| Zoom, tela cheia, recarregar | ⚙️ → Janela e app (ou Ctrl +, Ctrl −, Ctrl 0 e F11) |

## Sem VPN (Cloudflare Tunnel)

Instale o [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) e dê dois cliques em **`iniciar-servidor-online.bat`**. O terminal mostra um endereço `https://....trycloudflare.com`, que os amigos usam no login, sem VPN. Esse endereço muda sempre que o túnel reinicia.

Para a voz funcionar em qualquer conexão, configure um TURN uma vez. Crie uma chave em Realtime → TURN no painel da Cloudflare e rode:

```bash
cd server
node server.js --configurar-turn ID_DA_CHAVE TOKEN_DA_CHAVE
```

A chave fica em `server/data/config.json`, fora do git. Sem OneDrive, os uploads pelo túnel ficam limitados a 100 MB.

## OneDrive (opcional): os mesmos dados em qualquer PC

Com o OneDrive conectado, ele passa a guardar tudo do grupo: conversas, canais, sons, arquivos e a senha do servidor. Assim, não importa quem abre o servidor: os dados são sempre os mesmos. Os arquivos do chat vão direto do app para o OneDrive, sem usar a internet de quem hospeda. O servidor também guarda uma cópia das conversas a cada 6 horas e mantém as últimas 30.

O app só acessa a própria pasta (`Aplicativos/DJAchat`), nunca os demais arquivos da conta.

**Primeira vez do grupo:** quem guarda os dados dá dois cliques em **`conectar-onedrive.bat`**, aperta Enter e entra com a conta Microsoft dele seguindo o código mostrado.

**Outro PC vai hospedar (uma vez por PC):** com alguém já hospedando, abra o app e clique em ⚙️ Configurações → **Copiar código para hospedar**. No PC novo, dê dois cliques em `conectar-onedrive.bat`, cole o código e digite a senha do servidor. Não precisa entrar na conta Microsoft de ninguém. O código só funciona junto com a senha, mas trate-o como uma chave: ele dá acesso à pasta do DJAchat no OneDrive. Para cancelar todos os acessos, o dono da conta remove o app em account.microsoft.com → Privacidade → Aplicativos e serviços, e conecta de novo.

No fim, o terminal confirma quantas mensagens achou na conta.

**Só um servidor por vez.** Quem abre o servidor segura uma trava no OneDrive. Se outro PC tentar abrir junto, aparece "o servidor já está aberto em ...". Se o PC que hospedava desligou sem fechar o servidor, espere 2 minutos e abra de novo. Feche o servidor pela janela (ou com Ctrl+C) para ele enviar as últimas mudanças e liberar a trava na hora.

Na primeira vez, o servidor envia para o OneDrive as conversas e os arquivos que já estavam no PC. Se um PC tinha conversas diferentes das do OneDrive, valem as do OneDrive, e as dele ficam guardadas em `server/data/db.so-neste-pc-....json`. A senha é a do grupo: o terminal mostra qual é ao iniciar. A chave do TURN de quem conectou primeiro também fica disponível para os outros servidores, a menos que eles tenham a própria.

A autorização de cada PC fica em `server/data/config.json`, fora do git. Os uploads no OneDrive têm limite total de 200 GB; para mudar, use `LIMITE_ONEDRIVE_GB`. Se o OneDrive estiver fora do ar na hora de um envio, o arquivo fica no servidor e sobe sozinho depois.

## Problemas comuns

- **"Não consegui conectar"**: confira se o servidor está aberto, se o IP/porta estão certos e se todos estão na mesma rede da VPN. Libere o Node.js no Firewall do Windows quando ele perguntar (marque "redes privadas" **e** "públicas", porque a VPN às vezes aparece como rede pública).
- **Entrou na sala mas não ouve ninguém**: geralmente é firewall ou falta de VPN. Com Radmin, Tailscale ou ZeroTier quase sempre resolve.
- **Eco**: use fone de ouvido. O cancelamento de eco ajuda, mas não faz milagre.
- **Tela travando**: em ⚙️, baixe a qualidade para 720p. Quem transmite precisa de bom upload.
- **"O servidor já está aberto em ..."**: outro PC está hospedando com os dados do OneDrive. Feche aquele servidor primeiro; se ele caiu sem fechar, espere 2 minutos.
- **"Não consegui abrir os dados do grupo"**: o servidor não falou com o OneDrive. Confira a internet e abra de novo; nada é apagado.

## Segurança

O tráfego entre o app e o servidor não é criptografado (HTTP). Para uso entre amigos **dentro de uma VPN** isso é ok, porque a própria VPN já criptografa tudo. Não exponha o servidor direto na internet sem um proxy com HTTPS, porque a senha e as mensagens trafegariam abertas.

Cada app tem uma **conta leve**: um código secreto guardado no PC. O primeiro código que entra com um apelido fica dono dele, e só ele lê as próprias mensagens diretas e edita ou apaga as próprias mensagens. Para usar o mesmo apelido em outro PC, copie o código em ⚙️ Configurações → Sua conta e cole no outro. Se o código se perder (por exemplo, ao reinstalar o Windows), o apelido fica preso a ele.

Ainda não há administradores: quem tem a senha do servidor pode apagar e renomear canais e sons, e tirar ou mover pessoas da sala. Nesses casos, o app avisa quem fez.
