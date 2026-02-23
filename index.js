require('dotenv').config();
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const { MercadoPagoConfig, Payment } = require('mercadopago');
const { createClient } = require('@supabase/supabase-js');

// --- 1. CONFIGURAÇÕES INICIAIS ---

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const mpClient = new MercadoPagoConfig({ 
    accessToken: process.env.MP_ACCESS_TOKEN 
});
const payment = new Payment(mpClient);

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        headless: true, 
        args: ["--no-sandbox", "--disable-setuid-sandbox"] 
    },
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    }
});

const userSession = {}; 

// --- 2. EVENTOS DO BOT ---

client.on("qr", (qr) => {
    console.log("📌 Escaneie o QR Code abaixo para conectar:");
    qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
    console.log("🚀 JARIIMPORTS ONLINE E CONECTADA AO SUPABASE!");
});

// --- 3. LÓGICA PRINCIPAL DE MENSAGENS ---

client.on("message", async (msg) => {
    if (msg.from.endsWith("@g.us")) return; 

    const userId = msg.from;
    const input = msg.body.trim();
    const inputLower = input.toLowerCase();

    // A) REGISTRO DE ENDEREÇO
    if (userSession[userId]?.status === 'AGUARDANDO_ENDERECO') {
        userSession[userId].status = 'FINALIZADO';
        userSession[userId].endereco = input;
        return msg.reply("✅ *Endereço Registrado com Sucesso!*\nAssim que o pagamento for confirmado, seu pedido entrará em rota de entrega.");
    }

    // B) BUSCA DE PRODUTOS
    if (inputLower.startsWith("buscar ")) {
        const termoBusca = input.split(" ").slice(1).join(" ");
        
        const { data: resultados, error } = await supabase
            .from('produtos')
            .select('*')
            .ilike('nome', `%${termoBusca}%`);

        if (error || !resultados.length) {
            return msg.reply(`❌ Nenhum produto encontrado com o nome: *${termoBusca}*`);
        }

        let m = `🔍 *RESULTADOS PARA: ${termoBusca.toUpperCase()}*\n\n`;
        resultados.forEach(p => {
            m += `*ID: ${p.id}* - ${p.nome}\n💰 R$ ${p.preco.toFixed(2)}\n\n`;
        });
        return msg.reply(m + "Digite o *ID* para ver os detalhes e comprar.");
    }

    // C) MENU PRINCIPAL
    if (/^(loja|menu|Loja)$/i.test(inputLower)) {
        const { data: cats } = await supabase.from('categorias').select('*').order('id', {ascending: true});
        
        let menu = "*🛍️✨ CATÁLOGO JARIIMPORTS ✨🛍️*\n\n";
        menu += "🔎 *Busca Rápida:* Digite 'buscar' + o produto\n_(Ex: buscar airpods)_\n\n";
        menu += "🛒 *CATEGORIAS:*\n";
        
        if (cats) {
            cats.forEach(c => {
                menu += `*${c.id}* - ${c.icone || '📦'} ${c.nome}\n`;
            });
        }
        
        menu += "\n*0* - 👤 Falar com Atendente\n\nDigite o número desejado:";
        return client.sendMessage(userId, menu);
    }

    // D) TRATAMENTO DE NÚMEROS (Categorias ou IDs)
    if (/^\d+$/.test(input)) {
        const numInput = parseInt(input);

        if (numInput === 0) {
            return msg.reply("⏳ Você foi colocado na fila. Um de nossos atendentes entrará em contato em breve!");
        }

        const { data: cat } = await supabase.from('categorias').select('*').eq('id', numInput).single();
        
        if (cat) {
            const { data: prods } = await supabase.from('produtos').select('*').eq('categoria_id', numInput);
            
            if (!prods || !prods.length) {
                return msg.reply(`❌ A categoria *${cat.nome}* está sem estoque no momento.`);
            }

            let m = `📁 *${cat.nome.toUpperCase()}*\n\n`;
            prods.forEach(p => {
                m += `*ID: ${p.id}* - ${p.nome}\n💰 R$ ${p.preco.toFixed(2)}\n\n`;
            });
            return msg.reply(m + "Digite o *ID* do produto para ver a foto e comprar:");
        }

        const { data: p } = await supabase.from('produtos').select('*').eq('id', numInput).single();
        
        if (p) {
            if (p.estoque <= 0) return msg.reply("❌ Que pena! Este item acabou de esgotar.");
            
            userSession[userId] = { item: p, status: 'INTERESSE' };
            
            const legenda = `✨ *${p.nome}*\n\n💰 *Preço:* R$ ${p.preco.toFixed(2)}\n📦 *Estoque:* ${p.estoque} unidades\n\nDigite *PAGAR* para gerar o código Pix.`;

            try {
                const media = await MessageMedia.fromUrl(p.imagem);
                await client.sendMessage(userId, media, { caption: legenda });
            } catch (err) {
                await msg.reply(legenda); 
            }
            return;
        }
    }

    // E) PAGAMENTO PIX
    if (inputLower === 'pagar' && userSession[userId]?.status === 'INTERESSE') {
        const item = userSession[userId].item;
        await msg.reply("🔄 *Gerando Pix Copia e Cola...* Aguarde.");

        try {
            const res = await payment.create({
                body: {
                    transaction_amount: parseFloat(item.preco),
                    description: `JariImports: ${item.nome}`,
                    payment_method_id: 'pix',
                    payer: { email: 'vendas@jariimports.com' }
                }
            });

            const novoEstoque = item.estoque - 1;
            await supabase.from('produtos').update({ estoque: novoEstoque }).eq('id', item.id);

            await msg.reply("✅ *PIX GERADO!* Use o código abaixo no seu banco:");
            await msg.reply(res.point_of_interaction.transaction_data.qr_code);
            
            userSession[userId].status = 'AGUARDANDO_ENDERECO';
            await msg.reply("📍 Agora, digite seu ENDEREÇO COMPLETO: Rua, Número, Bairro, Ponto de Referência — envie tudo em uma só mensagem para agilizar seu atendimento. 🚚📦");

        } catch (error) {
            console.error("Erro MP:", error);
            await msg.reply("❌ Erro ao gerar o pagamento. Tente novamente ou digite 0 para suporte.");
        }
        return;
    }
});

client.initialize();