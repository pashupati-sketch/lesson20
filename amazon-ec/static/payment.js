document.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const orderId = parseInt(urlParams.get('order_id'), 10) || 1;
    const amount = parseInt(urlParams.get('amount'), 10) || 0;

    const amountDisplay = document.getElementById('payment-amount');
    if (amountDisplay) {
        amountDisplay.textContent = amount.toLocaleString();
    }

    const form = document.getElementById('payment-form');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();

            const selectedMethod = document.querySelector('input[name="method"]:checked');
            if (!selectedMethod) {
                alert('支払方法を選択してください。');
                return;
            }

            const paymentData = {
                order_id: orderId,
                amount: amount,
                method: selectedMethod.value
            };

            try {
                const response = await fetch('/api/payments', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(paymentData)
                });

                if (response.ok) {
                    const resultContainer = document.getElementById('payment-result');
                    if (resultContainer) {
                        resultContainer.innerHTML = '<p style="color: green; font-weight: bold;">決済が完了しました。</p><a href="/orders.html">注文履歴を見る</a>';
                    } else {
                        alert('決済が完了しました。');
                        window.location.href = '/orders.html';
                    }
                    form.style.display = 'none';
                } else {
                    const errorData = await response.json();
                    alert('エラー: ' + (errorData.error || '決済処理に失敗しました。'));
                }
            } catch (error) {
                console.error('Error:', error);
                alert('通信エラーが発生しました。');
            }
        });
    }
});