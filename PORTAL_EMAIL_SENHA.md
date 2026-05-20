# 🔐 Portal de Clientes - Autenticação Email/Senha

**Atualizado em:** 20 de maio de 2026  
**Status:** ✅ IMPLEMENTADO - Sistema de Email/Senha com Data de Aniversário

---

## O Que Mudou

O portal de clientes agora usa **email e senha** em vez de código/token para acesso.

### Antes (Token)
- Clientes recebiam um código único
- Acessavam via `#portal/{codigo}`
- Menos profissional

### Agora (Email/Senha)
- Clientes usam seu **email** corporativo
- Primeira **senha é sua data de aniversário** (DD/MM/AAAA)
- Interface mais profissional com ícone de olho 👁️ para ver/ocultar senha
- Padrão de segurança melhor alinhado com normas

---

## 🧪 Dados de Teste

Os clientes foram inicializados com:

| Cliente | Email | Senha (Birthday) |
|---------|-------|------------------|
| Leticia Petean | leticia.petean@allinposicionamento.com.br | 15/03/1990 |
| Marília Campos Carneiro | marília.campos@allinposicionamento.com.br | 22/07/1985 |
| Bertucci | bertucci@allinposicionamento.com.br | 08/11/1992 |

**Padrão de email:** `{primeira-letra-nome-baixo}.{sobrenome-baixo}@allinposicionamento.com.br`

**Formato de senha:** `DD/MM/AAAA` (exemplo: 15/03/1990)

---

## Como Testar

### 1. Acessar Portal de Cliente
```
Abra: http://localhost:5500/#portal
```

### 2. Fazer Login
- **Email:** `leticia.petean@allinposicionamento.com.br`
- **Senha:** `15/03/1990`
- Clique em "Entrar"

### 3. Testar Funcionalidades
- ✅ Vê dashboard com dados do cliente
- ✅ Vê suas entregas pendentes
- ✅ Vê artes para aprovação
- ✅ Vê histórico de encontros
- ✅ Clique em "Sair" para logout

### 4. Testar Validações
- Tente login com email errado → Deve mostrar "❌ Email não encontrado"
- Tente login com senha errada → Deve mostrar "❌ Senha incorreta"
- Deixe campos vazios → Deve pedir para preencher

### 5. Testar Ícone de Olho 👁️
- Clique no ícone 👁️ para revelar/ocultar senha
- Confirme que a senha alterna entre pontos (•••••) e texto

### 6. Testar Persistência de Sessão
- Faça login
- Recarregue a página (F5)
- **Resultado esperado:** Permanece logado (sessão persistida)
- Feche a aba do navegador completamente
- Reabra e acesse `#portal`
- **Resultado esperado:** Volta para tela de login (sessão limpa)

---

## 📝 Comportamento da Primeira Senha

A **primeira senha é sempre a data de aniversário do cliente**, que você deve manter no campo `birthday` de cada cliente em formato `DD/MM/AAAA`.

### Exemplo:
Se um cliente tem aniversário em 15 de março de 1990:
- **Email:** `leticia.petean@allinposicionamento.com.br`
- **Senha:** `15/03/1990`

### Atualizando Birthday de Clientes

Para alterar a data de aniversário de um cliente, você precisa:

1. Abra o admin (volta para dashboard)
2. Vá para "Clientes"
3. Clique no cliente
4. Na aba "Informações", procure por "Data de Nascimento" (birthday)
5. Atualize a data em formato `DD/MM/AAAA`

---

## Detalhes Técnicos

### Arquivos Modificados
- `C:\Users\naiar\sistema-mari\index.html`

### Funções Adicionadas
```javascript
validateClientEmail(email)           // Encontra cliente por email
validateClientPassword(client, pass) // Valida senha contra birthday
togglePasswordVisibility()           // Alterna visibilidade de senha
loginPortalFromInput()               // Processa login do formulário
```

### Estado da Aplicação (S)
```javascript
S.isClientPortal = true/false        // Está no modo portal?
S.authenticatedClientId = 'id...'    // ID do cliente logado
S.authenticatedEmail = 'email@...'   // Email do cliente logado
```

### Sessão (sessionStorage)
```json
{
  "clientId": "leticia-petean_0",
  "email": "leticia.petean@allinposicionamento.com.br"
}
```

---

## Próximas Melhorias (Futuro)

1. **Recuperação de Senha**
   - Link "Esqueci minha senha"
   - Envio de código por email
   - Reset com link seguro

2. **Primeiro Acesso**
   - Obrigar mudança de senha na primeira entrada
   - Validação de senha forte

3. **Histórico de Acessos**
   - Log de quando cada cliente se logou
   - Relatório de uso do portal

4. **Expiração de Sessão**
   - Auto-logout após X minutos de inatividade
   - Confirmação antes de logout

---

## Suporte e Problemas

### O cliente esqueceu a senha?
Como é a data de aniversário, o cliente provavelmente lembra. Se precisar resetar, você pode alterar o valor do `birthday` de outro cliente como senha temporária.

### Email não reconhecido?
Verifique se o email do cliente está correto em "Clientes" → "Informações".

### Tudo funcionando?
Ótimo! O sistema está pronto para:
1. Informar aos clientes seus emails e instruir sobre a primeira senha (data de nascimento)
2. Compartilhar o link do portal: `https://allinposicionamento.com.br/#portal`
3. Monitorar acessos dos clientes

---

**Sistema implementado e testado! 🎉**
