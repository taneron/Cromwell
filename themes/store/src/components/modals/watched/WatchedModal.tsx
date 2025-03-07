import { TAttribute, TStoreListItem } from '@cromwell/core';
import { getCStore, getGraphQLClient, getGraphQLErrorInfo } from '@cromwell/core-frontend';
import { IconButton } from '@mui/material';
import clsx from 'clsx';
import { observer } from 'mobx-react';
import React, { useEffect, useState } from 'react';

import { appState } from '../../../helpers/AppState';
import { useForceUpdate } from '../../../helpers/forceUpdate';
import commonStyles from '../../../styles/common.module.scss';
import { CloseIcon } from '../../icons';
import { LoadBox } from '../../loadbox/Loadbox';
import { ProductCard } from '../../productCard/ProductCard';
import Modal from '../baseModal/Modal';
import styles from './WatchedModal.module.scss';

export const WatchedModal = observer(() => {
    const forceUpdate = useForceUpdate();
    const handleClose = () => {
        appState.isWatchedOpen = false;
    }

    const [list, setList] = useState<TStoreListItem[]>([]);
    const [attributes, setAttributes] = useState<TAttribute[]>([]);
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const cstore = getCStore();

    const updateAttributes = async () => {
        try {
            const data = await getGraphQLClient()?.getAttributes();
            if (data) setAttributes(data);
        } catch (e) {
            console.error(getGraphQLErrorInfo(e));
        }
    }

    useEffect(() => {
        /**
         * Since getCart method wll retrieve products from local storage and 
         * after a while products can be modified at the server, we need to refresh cart first  
         */
        if (appState.isWatchedOpen) {
            (async () => {
                setIsLoading(true);
                await Promise.all([cstore.updateWatchedItems(), updateAttributes()])
                const watched = cstore.getWatchedItems()
                setList(watched);
                setIsLoading(false);
            })();
        }
    }, [appState.isWatchedOpen]);

    useEffect(() => {
        cstore.onWatchedItemsUpdate(() => {
            const watched = cstore.getWatchedItems();
            setList(watched);
            forceUpdate();
        }, 'WatchedModal');
    }, []);

    return (
        <Modal
            className={clsx(commonStyles.center)}
            open={appState.isWatchedOpen}
            onClose={handleClose}
            blurSelector={"#CB_root"}
        >
            <div className={clsx(styles.watchedModal)}>
                <IconButton
                    aria-label="Close recently viewed items"
                    onClick={handleClose} className={styles.closeBtn}>
                    <CloseIcon />
                </IconButton>
                {isLoading && (
                    <LoadBox />
                )}
                {!isLoading && (
                    <div className={styles.watched}>
                        <h3 className={styles.modalTitle}>Watched Items</h3>
                        {[...list].reverse().map((it, i) => {
                            return (
                                <ProductCard
                                    className={styles.productCard}
                                    attributes={attributes}
                                    key={i}
                                    data={it.product}
                                    variant='list'
                                />
                            )
                        })}
                    </div>
                )}
            </div>
        </Modal>
    )
});