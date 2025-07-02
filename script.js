// Variáveis globais para o jogo e o Stockfish
var game = new Chess();
var board = null;
var stockfish = null;

// Valores iniciais para os sliders
var currentDepth = 10;
var currentSkillLevel = 10;

// Referências jQuery para os elementos da UI
var $status, $analysisOutput, $depthSlider, $currentDepthSpan, $skillLevelSlider, $currentSkillLevelSpan;

// --- Funções de Comunicação com Stockfish ---

/**
 * Envia um comando para o Stockfish e aguarda uma resposta específica.
 * @param {string} command - O comando UCI a ser enviado.
 * @param {string} expectedResponseStart - O prefixo da resposta esperada (ex: 'bestmove', 'info depth').
 * @param {number} timeout - Tempo limite em ms para aguardar a resposta.
 * @returns {Promise<string>} Uma promessa que resolve com a primeira mensagem que começa com expectedResponseStart.
 */
function sendStockfishCommand(command, expectedResponseStart, timeout = 5000) {
    return new Promise((resolve, reject) => {
        let timer = setTimeout(() => {
            stockfish.onmessage = null; // Limpa o handler
            reject('Timeout: Stockfish não respondeu a ' + command + ' com ' + expectedResponseStart);
        }, timeout);

        stockfish.onmessage = function (event) {
            var message = event.data || event;
            // console.log("Stockfish message:", message); // Para depuração

            if (message.startsWith(expectedResponseStart)) {
                clearTimeout(timer);
                stockfish.onmessage = null; // Limpa o handler para esta requisição
                resolve(message);
            }
            // Se for uma análise (info depth), podemos coletar e continuar aguardando o bestmove
            // A lógica de 'go infinite' e 'stop' é mais robusta para análise contínua.
            // Para 'go depth', o bestmove virá no final.
            if (expectedResponseStart === 'bestmove' && message.startsWith('info depth')) {
                // Você pode armazenar essas linhas se quiser mostrá-las antes do bestmove
                // ou simplesmente ignorá-las se o objetivo é apenas o bestmove final.
            }
        };
        stockfish.postMessage(command);
    });
}

/**
 * Obtém o melhor movimento do Stockfish para a posição atual.
 * @param {number} depth - Profundidade de busca.
 * @returns {Promise<string>} O movimento no formato UCI.
 */
async function getStockfishMove(depth) {
    try {
        await sendStockfishCommand('ucinewgame', 'readyok', 1000); // Garante um novo jogo UCI
        await sendStockfishCommand('isready', 'readyok', 1000); // Garante que está pronto
        stockfish.postMessage('setoption name Skill Level value ' + currentSkillLevel);
        await sendStockfishCommand('setoption name Skill Level value ' + currentSkillLevel, 'option set', 500); // Confirma a opção
        stockfish.postMessage('position fen ' + game.fen());
        const response = await sendStockfishCommand('go depth ' + depth, 'bestmove', 15000); // Aumenta timeout para movimento
        const bestMoveMatch = response.match(/bestmove\s(\S+)/);
        if (bestMoveMatch && bestMoveMatch[1]) {
            return bestMoveMatch[1];
        } else {
            console.error("Stockfish did not return a bestmove.", response);
            return null;
        }
    } catch (error) {
        console.error("Error getting Stockfish move:", error);
        return null;
    }
}

/**
 * Obtém uma análise da posição atual do Stockfish.
 * @param {number} depth - Profundidade de busca.
 * @returns {Promise<string>} Uma string formatada com a análise.
 */
async function getStockfishAnalysis(depth) {
    return new Promise((resolve) => {
        let analysisBuffer = [];
        let timer = null;

        stockfish.onmessage = function (event) {
            var message = event.data || event;
            // console.log("Analysis message:", message); // Para depuração

            if (message.startsWith('info depth')) {
                analysisBuffer.push(message);
                // Atualiza a saída em tempo real
                const lines = analysisBuffer.filter(line => line.startsWith('info depth'));
                const relevantLines = lines.slice(Math.max(lines.length - 5, 0)); // Últimas 5 linhas
                $analysisOutput.text(relevantLines.join('\n'));

                clearTimeout(timer);
                timer = setTimeout(() => {
                    // Assume que a análise diminuiu ou parou se nenhuma nova mensagem por 500ms
                    stockfish.postMessage('stop'); // Pede para Stockfish parar de pensar
                    stockfish.onmessage = null;
                    resolve(relevantLines.join('\n') || 'Nenhuma análise detalhada.');
                }, 500);
            } else if (message.startsWith('bestmove')) {
                // Se receber o bestmove, é o fim da análise de 'go depth' ou 'go infinite' com stop.
                clearTimeout(timer);
                stockfish.onmessage = null;
                resolve(analysisBuffer.filter(line => line.startsWith('info depth')).slice(-5).join('\n') + '\nBest move: ' + message.split(' ')[1]);
            }
        };

        // Inicia a análise
        stockfish.postMessage('ucinewgame');
        stockfish.postMessage('isready');
        stockfish.postMessage('position fen ' + game.fen());
        // Manda o Stockfish analisar por um tempo limitado ou até encontrar um bestmove
        stockfish.postMessage('go depth ' + depth);

        // Define um tempo limite geral para a análise, caso não venha 'bestmove' ou 'info' suficiente
        setTimeout(() => {
            stockfish.postMessage('stop');
            stockfish.onmessage = null;
            resolve(analysisBuffer.filter(line => line.startsWith('info depth')).slice(-5).join('\n') || 'Análise concluída.');
        }, depth * 1000 + 1000); // Ex: depth 10 = 11 segundos de timeout
    });
}


// --- Funções de Tabuleiro e Lógica do Jogo ---

// Função chamada quando uma peça começa a ser arrastada
function onDragStart(source, piece, position, orientation) {
    if (game.game_over() === true ||
        (game.turn() === 'w' && piece.search(/^b/) !== -1) ||
        (game.turn() === 'b' && piece.search(/^w/) !== -1)) {
        return false;
    }
}

// Função chamada quando uma peça é solta
async function onDrop(source, target) {
    var move = game.move({
        from: source,
        to: target,
        promotion: 'q' // Sempre promove para rainha por simplicidade
    });

    if (move === null) return 'snapback'; // Movimento ilegal

    await updateStatus(); // Aguarda a atualização do status e análise
    if (game.game_over() === false) {
        // Aguarda um pequeno delay antes do Stockfish mover para a UI atualizar
        setTimeout(makeStockfishMove, 500);
    }
}

// Atualiza a posição do tabuleiro após um 'snapback' (movimento ilegal)
function onSnapEnd() {
    board.position(game.fen());
}

// Atualiza o status do jogo (xeque, mate, turno, etc.) e a análise do Stockfish
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
        // Solicita e exibe a análise do Stockfish
        $analysisOutput.text('Analisando...'); // Mensagem enquanto Stockfish pensa
        await getStockfishAnalysis(currentDepth);
    }
    $status.html(status);
}

// Função para o Stockfish fazer um movimento
async function makeStockfishMove() {
    if (game.game_over() === true) return;

    $status.text('Stockfish pensando...');
    const bestMove = await getStockfishMove(currentDepth);

    if (bestMove) {
        console.log("Stockfish Best Move:", bestMove);
        game.move(bestMove, { sloppy: true }); // 'sloppy' para aceitar formato UCI
        board.position(game.fen());
        updateStatus();
    } else {
        $status.text('Stockfish não encontrou um movimento ou houve um erro.');
        console.error("Erro ou movimento não encontrado pelo Stockfish.");
    }
}

// Desfazer o último movimento
function undoLastMove() {
    if (game.history().length > 0) {
        game.undo(); // Desfaz o movimento do jogador
        if (game.history().length > 0 && game.turn() !== 'w') { // Se o Stockfish já tiver movido, desfaz o dele também
             game.undo();
        }
        board.position(game.fen());
        updateStatus();
    } else {
        $status.text('Não há movimentos para desfazer.');
    }
}


// --- Inicialização e Event Listeners ---

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
        onSnapEnd: onSnapEnd,
        // Configura o caminho para as imagens das peças via CDN
        pieceTheme: 'https://unpkg.com/chessboard-js@1.0.0/img/chesspieces/wikipedia/{piece}.png'
    });

    // Inicializa o Stockfish.js como um Worker
    stockfish = new Worker('https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js');
    stockfish.postMessage('uci'); // Inicia o protocolo UCI
    stockfish.postMessage('isready'); // Pergunta se está pronto
    stockfish.postMessage('ucinewgame'); // Começa um novo jogo no Stockfish

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
        // Não é necessário enviar o skill level para o Stockfish a cada mudança do slider.
        // Ele será enviado antes de cada chamada 'go'.
    });
    // Define o valor inicial no span
    $currentSkillLevelSpan.text($skillLevelSlider.val());

    // Botão Novo Jogo
    $('#new-game-btn').on('click', function() {
        game.reset();
        board.position('start');
        stockfish.postMessage('ucinewgame'); // Reinicia o Stockfish também
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
        const bestMove = await getStockfishMove(currentDepth);
        if (bestMove) {
            $analysisOutput.text('Dica: Melhor movimento é ' + bestMove);
        } else {
            $analysisOutput.text('Não foi possível obter uma dica.');
        }
    });

    // Botão Mover Stockfish (útil para testar ou jogar contra o Stockfish)
    $('#stockfish-move-btn').on('click', function() {
        makeStockfishMove();
    });

    // Botão Desfazer
    $('#undo-move-btn').on('click', function() {
        undoLastMove();
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
//    ou explicitamente por game.moves() para obter uma lista.
// 6. Reiniciar Jogo: Implementado no botão 'Novo Jogo' usando game.reset() e board.position('start').
// 7. Desfazer Movimento: Implementado no botão 'Desfazer' usando undoLastMove().
// 8. Obter Dica (Stockfish): Implementado no botão 'Pedir Dica' usando getStockfishMove.
// 9. Obter Melhor Movimento (Stockfish): Implementado em makeStockfishMove usando getStockfishMove.
// 10. Analisar Posição (Stockfish): Implementado em updateStatus usando getStockfishAnalysis para mostrar 'info depth'.
