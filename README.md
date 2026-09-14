# Pokémon Gustavo — Deck Builder

Fichas e deck building do sistema de RPG "Pokémon Gustavo", com salas de Mestre/Jogador.

## O que mudou em relação à versão do claude.ai

Nesta versão os papéis são **aplicados no servidor**, não por convenção:

- Cada pessoa recebe um **token** ao criar ou entrar numa sala.
- O servidor filtra o que cada um enxerga: jogador vê só as próprias fichas, Mestre vê todas.
- Um jogador **não consegue** editar nem apagar a ficha de outro, nem mexendo no navegador.
- O Mestre pode editar qualquer ficha da sala, e o dono original é preservado.

---

## Deploy no Render

### 1. Suba o código para um repositório no GitHub

```bash
git init
git add .
git commit -m "Pokémon Gustavo"
git remote add origin https://github.com/SEU_USUARIO/pokemon-gustavo.git
git push -u origin main
```

### 2. Crie o banco de dados (faça isso primeiro)

No Render: **New → Postgres**

- Escolha um nome (ex: `pokemon-gustavo-db`)
- Depois de criado, copie a **Internal Database URL**

> Sem banco o app funciona, mas guarda tudo em memória e **perde os dados a cada reinício**.
> No plano gratuito do Render o serviço hiberna quando fica ocioso, então o banco não é opcional na prática.

### 3. Crie o Web Service

No Render: **New → Web Service** → conecte o repositório.

| Campo | Valor |
|---|---|
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |

### 4. Variáveis de ambiente

Em **Environment**, adicione:

| Chave | Valor | Obrigatório |
|---|---|---|
| `DATABASE_URL` | a Internal Database URL do passo 2 | sim (para persistir) |

O `PORT` o Render define sozinho, não precisa configurar.

### 5. Deploy

Clique em **Create Web Service**. Ao final você recebe uma URL tipo
`https://pokemon-gustavo.onrender.com` — é o link do site.

---

## Rodando local

```bash
npm install
npm start
# abre http://localhost:3000
```

Para testar com banco local:

```bash
DATABASE_URL=postgres://usuario:senha@localhost:5432/pokemon npm start
```

---

## Como usar

1. **Mestre**: abre o site, põe o nome, dá o nome da campanha e clica em **Criar Sala**.
2. Clica em **🔗 Convidar** — o link é copiado para a área de transferência.
3. **Jogadores**: abrem o link, digitam o nome e entram direto na sala.
4. Cada jogador monta suas fichas; o Mestre vê todas, agrupadas por jogador na barra lateral.

O código da sala também funciona sozinho, se preferir passar só o código.

---

## Estrutura

```
server.js          API + regras de permissão
package.json
public/index.html  aplicação inteira (front-end)
```

Os sprites são carregados do repositório público do PokeAPI, então não ficam no projeto.

## Modo Batalha (beta)

O botão **⚔ Batalha** no topo entra no modo de combate:

- Os **6 primeiros** da barra lateral são os que entram em campo. Use as setas ▲▼ para reordenar.
- Cada Pokémon em campo ganha um painel com **barra de HP** (botões rápidos -1 / -5 / -10 e campo
  para dano ou cura de qualquer valor) e **estágios de Status**.
- Os estágios seguem a regra do sistema: cada estágio vale **10% do Status original**, limitado a
  **6 para cima ou para baixo**. O valor exibido já é o Status efetivo.
- **↺ Restaurar** devolve HP cheio e zera os estágios de um Pokémon; **Restaurar Todos** faz isso
  com os 6 em campo de uma vez.

O estado de batalha fica salvo no servidor, então o Mestre e o dono da ficha veem o mesmo HP.
O Mestre pode alterar o HP e os estágios de qualquer Pokémon da sala.

HP não tem estágio (conforme as regras), então só aparecem ATK, DEF, SPA, SPD e SPE.

## Descrições dos golpes

Vêm em inglês, direto dos dados dos jogos (não existe versão oficial em português).
Todo campo de descrição é editável na ficha, então dá para reescrever à mão o que quiser.

## Observações

- O plano gratuito do Render hiberna o serviço após inatividade; a primeira visita depois disso
  demora ~30s para responder.
- O Postgres gratuito do Render expira depois de um período — confira o plano atual antes de
  depender dele para uma campanha longa.
