// A inicialização das variáveis globais deve estar disponível antes do $(document).ready
var game = new Chess();
var board = null;
var stockfish = null; // A instância do Stockfish.js
var currentDepth = 10;
var currentSkillLevel = 10; // Corresponde ao "Skill Level" do Stockfish

// Usar JQuery para selecionar elementos quando o DOM estiver pronto
var $status, $analysisOutput, $depthSlider, $currentDepthSpan, $skillLevelSlider, $currentSkillLevelSpan;

/**
 * Envia um comando para o Stockfish e lida com a resposta.
 * @param {string} command - O comando UCI a ser enviado (ex: "go depth 10", "position startpos moves e2e4").
 * @returns {Promise<string>} Uma promessa que resolve com a resposta do Stockfish.
 */
function sendStockfishCommand(command) {
    return new Promise((resolve) => {
        stockfish.onmessage = function (event) {
            var message = event.data || event;
            // Filtra mensagens irrelevantes para manter a saída limpa,
            // e captura as linhas que queremos.
            if (message.startsWith('bestmove') || message.startsWith('info depth')) {
                resolve(message);
                // Importante: Limpa o onmessage handler APENAS se a mensagem for final.
                // Para 'info depth', Stockfish envia múltiplas linhas, então precisamos ter cuidado.
                // Para este exemplo, resolvemos na primeira 'bestmove' ou 'info depth'.
                // Em um app mais complexo, você acumularia as 'info' e só resolveria no 'bestmove'.
                if (message.startsWith('bestmove')) {
                    stockfish.onmessage = null;
                }
            } else if (message.includes('No bestmove found')) {
                resolve('No bestmove found');
                stockfish.onmessage = null;
            }
        };
        stockfish.postMessage(command);
    });
}

/**
 * Obtém o melhor movimento do Stockfish para a posição atual.
 * @param {number} depth - Profundidade de busca.
 * @returns {Promise<string>} A promessa que resolve com o comando 'bestmove' do Stockfish.
 */
async function getStockfishMove(depth) {
    // Certifica-se de que o Stockfish está pronto e limpo para um novo comando
    await sendStockfishCommand('ucinewgame');
    await sendStockfishCommand('isready');
    await sendStockfishCommand('setoption name Skill Level value ' + currentSkillLevel);
    await sendStockfishCommand('position fen ' + game.fen());
    // Manda o Stockfish pensar. Pode demorar.
    const response = await sendStockfishCommand('go depth ' + depth);
    console.log("Stockfish Best Move Response:", response);
    return response;
}

/**
 * Obtém uma análise da posição atual do Stockfish.
 * @param {number} depth - Profundidade de busca para análise.
 * @returns {Promise<string>} Uma promessa que resolve com a saída de análise do Stockfish.
 */
async function getStockfishAnalysis(depth) {
    // Para análise, vamos coletar todas as linhas 'info depth' e não apenas a primeira
    return new Promise((resolve) => {
        let analysisOutput = '';
        let timer = null; // Usado para detectar quando o Stockfish parou de enviar 'info'

        stockfish.onmessage = function (event) {
            var message = event.data || event;
            if (message.startsWith('info depth')) {
                analysisOutput += message + '\n';
                // Reseta o timer a cada nova linha 'info depth'
                clearTimeout(timer);
                timer = setTimeout(() => {
                    // Se nenhuma nova linha 'info depth' for recebida em 200ms, assume que a análise terminou
                    stockfish.onmessage = null; // Limpa o handler
                    resolve(analysisOutput);
                }, 200);
            } else if (message.startsWith('bestmove')) {
                // Se receber 'bestmove' inesperadamente, termina a análise
                clearTimeout(timer);
                stockfish.onmessage = null; // Limpa o handler
                resolve(analysisOutput + '\n' + message);
            }
        };
        // Envia o comando para análise. 'infinite' significa que ele continua analisando até 'stop'.
        stockfish.postMessage('ucinewgame');
        stockfish.postMessage('isready');
        stockfish.postMessage('position fen ' + game.fen());
        stockfish.postMessage('go infinite'); // Inicia a análise contínua

        // Define um tempo limite para parar a análise e resolver a promessa
        setTimeout(() => {
            stockfish.postMessage('stop'); // Pede para o Stockfish parar de pensar
            clearTimeout(timer);
            stockfish.onmessage = null; // Limpa o handler para evitar múltiplos handlers
            resolve(analysisOutput || 'Análise não disponível.'); // Resolve com o que foi coletado
        }, 5000); // Para a análise após 5 segundos
    });
}

// --- Funções de Tabuleiro e Lógica do Jogo ---

function onDragStart(source, piece, position, orientation) {
    if (game.game_over() === true ||
        (game.turn() === 'w' && piece.search(/^b/) !== -1) ||
        (game.turn() === 'b' && piece.search(/^w/) !== -1)) {
        return false;
    }
}

function onDrop(source, target) {
    var move = game.move({
        from: source,
        to: target,
        promotion: 'q'
    });

    if (move === null) return 'snapback';

    updateStatus();
    // Apenas move o Stockfish se o jogo não tiver terminado após o movimento do jogador
    if (game.game_over() === false) {
        makeStockfishMove();
    }
}

function onSnapEnd() {
    board.position(game.fen());
}

async function updateStatus() {
    var status = '';
    var moveColor = 'Brancas';
    if (game.turn() === 'b') {
        moveColor = 'Pretas';
    }

    if (game.in_checkmate() === true) {
        status = 'Jogo Encerrado, ' + moveColor + ' está em xeque-mate.';
        $analysisOutput.text('');
    } else if (game.in_draw() === true) {
        status = 'Jogo Encerrado, Empate.';
        $analysisOutput.text('');
    } else {
        status = 'Turno das ' + moveColor;
        if (game.in_check() === true) {
            status += ', ' + moveColor + ' está em xeque.';
        }
        // Solicita análise do Stockfish após cada movimento
        $analysisOutput.text('Analisando...');
        const analysis = await getStockfishAnalysis(currentDepth);
        // Exibe apenas as últimas 5 linhas de info depth para não sobrecarregar
        const lines = analysis.split('\n').filter(line => line.startsWith('info depth'));
        const relevantLines = lines.slice(Math.max(lines.length - 5, 0));
        $analysisOutput.text(relevantLines.join('\n'));
    }
    $status.html(status);
}

async function makeStockfishMove() {
    if (game.game_over() === true) return;

    $status.text('Stockfish pensando...');
    const stockfishResponse = await getStockfishMove(currentDepth);
    const bestMoveMatch = stockfishResponse.match(/bestmove\s(\S+)/);

    if (bestMoveMatch && bestMoveMatch[1]) {
        const bestMove = bestMoveMatch[1];
        console.log("Stockfish Best Move:", bestMove);
        game.move(bestMove, { sloppy: true }); // 'sloppy' para aceitar formato UCI
        board.position(game.fen());
        updateStatus();
    } else {
        $status.text('Stockfish não encontrou um movimento ou o jogo terminou.');
        console.error("Erro ao obter o melhor movimento do Stockfish:", stockfishResponse);
    }
}

// --- Inicialização e Event Listeners (dentro de $(document).ready) ---

$(document).ready(function() {
    // Atribui os elementos jQuery após o DOM estar pronto
    $status = $('#game-status');
    $analysisOutput = $('#analysis-output');
    $depthSlider = $('#depth-slider');
    $currentDepthSpan = $('#current-depth');
    $skillLevelSlider = $('#skill-level-slider');
    $currentSkillLevelSpan = $('#current-skill-level');

    // Inicializa o tabuleiro
    board = Chessboard('board', {
        draggable: true,
        position: 'start',
        onDragStart: onDragStart,
        onDrop: onDrop,
        onSnapEnd: onSnapEnd
    });

    // Inicializa o Stockfish.js como um Worker
    stockfish = new Worker('https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js');
    stockfish.postMessage('uci'); // Envia o comando UCI para iniciar o Stockfish
    stockfish.postMessage('isready');
    stockfish.postMessage('ucinewgame'); // Inicia um novo jogo no Stockfish

    // Atualiza os valores dos sliders na interface E as variáveis globais
    $depthSlider.on('input', function() {
        currentDepth = $(this).val();
        $currentDepthSpan.text(currentDepth);
    });
    // Define o valor inicial no span
    $currentDepthSpan.text($depthSlider.val());


    $skillLevelSlider.on('input', function() {
        currentSkillLevel = $(this).val();
        $currentSkillLevelSpan.text(currentSkillLevel);
        // O Stockfish aplica o skill level automaticamente nas próximas chamadas 'go'
    });
    // Define o valor inicial no span
    $currentSkillLevelSpan.text($skillLevelSlider.val());

    // Botão Novo Jogo
    $('#new-game-btn').on('click', function() {
        game.reset();
        board.position('start');
        stockfish.postMessage('ucinewgame');
        stockfish.postMessage('isready');
        $analysisOutput.text('');
        updateStatus();
    });

    // Botão Pedir Dica
    $('#hint-btn').on('click', async function() {
        if (game.game_over() === true) {
            $analysisOutput.text('O jogo já terminou, não há dicas.');
            return;
        }
        $analysisOutput.text('Pensando em uma dica...');
        // Para uma dica, podemos pedir um bestmove e mostrar
        const hintResponse = await getStockfishMove(currentDepth);
        const bestMoveMatch = hintResponse.match(/bestmove\s(\S+)/);
        if (bestMoveMatch && bestMoveMatch[1]) {
            $analysisOutput.text('Dica: Melhor movimento é ' + bestMoveMatch[1]);
        } else {
            $analysisOutput.text('Não foi possível obter uma dica.');
        }
    });

    // Botão Mover Stockfish (útil para testar ou jogar contra o Stockfish)
    $('#stockfish-move-btn').on('click', function() {
        makeStockfishMove();
    });

    // Estado inicial
    updateStatus();
});

// --- As 10 Funções de Xadrez (Revisão e Notas) ---
// Com as bibliotecas chess.js e Stockfish.js, a maioria dessas funções é simplificada:

// 1. Mover Peça: Implementado via game.move() no onDrop, e board.position() para renderizar.
// 2. Verificar Xeque: Implementado via game.in_check() em updateStatus.
// 3. Verificar Xeque-Mate: Implementado via game.in_checkmate() em updateStatus.
// 4. Verificar Afogamento (Stalemate): Implementado via game.in_draw() em updateStatus.
//    (O chess.js lida com stalemate, threefold repetition, 50-move rule, e material insuficiente)
// 5. Gerar Movimentos Legais: Implicitamente gerenciado por game.move() (que retorna null se o movimento for ilegal)
//    ou game.moves() para obter uma lista.
// 6. Reiniciar Jogo: Implementado no botão 'Novo Jogo' usando game.reset() e board.position('start').
// 7. Desfazer Movimento: Pode ser implementado com game.undo() (requer um botão/lógica adicional).
//    Exemplo: function undoLastMove() { if (game.undo()) { board.position(game.fen()); updateStatus(); } }
// 8. Obter Dica (Stockfish): Implementado no botão 'Pedir Dica' usando getStockfishMove.
// 9. Obter Melhor Movimento (Stockfish): Implementado em makeStockfishMove usando getStockfishMove.
// 10. Analisar Posição (Stockfish): Implementado em updateStatus usando getStockfishAnalysis para mostrar 'info depth'.
