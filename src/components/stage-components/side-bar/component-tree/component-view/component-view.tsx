import React, { useContext, useCallback } from 'react';
import _ from 'lodash';
import classNames from 'classnames';
import { Icon } from '@teambit/evangelist-temp.elements.icon';
import { TreeNodeProps } from '../recursive-tree';
import { ComponentTreeContext } from '../component-tree-context';
import { indentClass } from '../indent';
import { getName } from '../utils/get-name';
import { clickable } from '../../../../../to-eject/css-components/clickable';
import { hoverable } from '../../../../../to-eject/css-components/hoverable';
import { PayloadType } from '../payload-type';
import { componentToUrl } from '../../../../../extensions/component/component-path.ui';
import { NavLink } from '../../../../../extensions/react-router/nav-link';
import { ComponentIcon } from '../../../workspace-components/component-icon';
import { ComponentStatusResolver } from '../component-status-resolver';
import styles from './component-view.module.scss';

export type ComponentViewProps<Payload = any> = {
  // env?: 'react' | 'angular' | 'vue' | 'stencil';
} & TreeNodeProps<Payload>;

export function ComponentView(props: ComponentViewProps<PayloadType>) {
  const { node } = props;
  const { payload } = node;
  const isDeprecated = _.get(payload, ['deprecation', 'isDeprecate']);
  const status = _.get(payload, ['status']);

  const { onSelect } = useContext(ComponentTreeContext);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement, MouseEvent>) => {
      onSelect && onSelect(node.id, event);
    },
    [onSelect, node.id]
  );

  return (
    <NavLink
      href={componentToUrl(node.id)} // consider replacing this with node.payload
      className={classNames(indentClass, clickable, hoverable, styles.component)}
      activeClassName={styles.active}
      onClick={handleClick}
    >
      <div className={styles.left}>
        {payload && <ComponentIcon component={payload} className={styles.envIcon} />}
        <span>{getName(node.id)}</span>
      </div>

      <div className={styles.right}>
        {isDeprecated && <Icon of="note-deprecated" className={styles.componentIcon} />}
        {/* {isInternal && <Icon of="Internal" className={styles.componentIcon} />} */}
        <ComponentStatusResolver status={status} />
      </div>
    </NavLink>
  );
}
