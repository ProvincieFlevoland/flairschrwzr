<script>
    import { flip } from 'svelte/animate';
    import { fade, fly } from 'svelte/transition';
    import { notifications, dismissNotification } from '$lib/notificationStore.js';
    import './ToastContainer.css';

    /** Map notification type to icon. */
    const typeToIcon = {
        success: 'ph-bold ph-check-circle',
        error: 'ph-bold ph-warning-circle',
        warning: 'ph-bold ph-warning',
        info: 'ph-bold ph-info'
    };
</script>

<div class={'sa-toast-container-toast-container'}>
    {#each $notifications as toast (toast.id)}
        <div
            class="{'sa-toast-container-toast'} {`sa-toast-container-toast-${toast.type}`}"
            role="alert"
            animate:flip={{ duration: 300 }}
            in:fly={{ y: -20, duration: 400 }}
            out:fade={{ duration: 200 }}
        >
            <div class={'sa-toast-container-toast-icon'}>
                <i class={typeToIcon[toast.type] || 'ph-bold ph-info'}></i>
            </div>
            <div class={'sa-toast-container-toast-content'}>
                {toast.message}
            </div>
            <button class={'sa-toast-container-toast-close'} on:click={() => dismissNotification(toast.id)} aria-label="Close">
                <i class="ph ph-x"></i>
            </button>
        </div>
    {/each}
</div>
